//! Job-Queue: ein Worker (ein Export zur Zeit, §3.4), Fortschritt, Abbruch, Timeout.
//! Offene Jobs stehen in <Datenordner>/.jobs.json und laufen nach einem Neustart weiter, statt vergessen zu werden.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{JobInfo, JobSpec, JobState};

/// Fertige Jobs, die für `Jobs` im Speicher bleiben
const KEEP_DONE: usize = 50;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);
/// Obergrenze für `timeout_s`
pub const MAX_TIMEOUT: Duration = Duration::from_secs(86_400);

/// Mutex auch nach einer Panik in einem anderen Thread weiter benutzen: der Zustand ist dann höchstens veraltet,
/// ein vergifteter Mutex legte dagegen den ganzen Daemon lahm.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unbekannt".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Cancelled,
    TimedOut,
}

/// Was ein laufender Job sieht: Abbruch/Timeout prüfen und Fortschritt melden.
/// ponytail: geprüft wird zwischen Schritten (je Folie/Format); ein einzelner hängender Schritt ist nicht unterbrechbar,
/// dafür bräuchte es einen Kindprozess je Job.
pub struct Ctl {
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    progress: Box<dyn Fn(f32) + Send + Sync>,
}

impl Ctl {
    pub fn check(&self) -> Result<(), Stop> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Stop::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(Stop::TimedOut)
        } else {
            Ok(())
        }
    }
    /// 0..1
    pub fn progress(&self, p: f32) {
        (self.progress)(p.clamp(0.0, 1.0));
    }
}

/// Ergebnis eines Laufs: geschriebene Dateien und Warnungen, sonst Abbruch oder Fehlertext
pub enum Outcome {
    Done(Vec<PathBuf>, Vec<String>),
    Stopped(Stop),
    Failed(String),
}

pub type Runner = Box<dyn Fn(&JobSpec, &Ctl) -> Outcome + Send + Sync>;
pub type Notify = Box<dyn Fn(&JobInfo) + Send + Sync>;

#[derive(Clone, Serialize, Deserialize)]
struct Job {
    info: JobInfo,
    spec: JobSpec,
    timeout_ms: u64,
    #[serde(skip)]
    cancel: Arc<AtomicBool>,
}

struct State {
    jobs: Vec<Job>,
    next: u64,
}

struct Shared {
    state: Mutex<State>,
    cv: Condvar,
    file: PathBuf,
    notify: Notify,
}

#[derive(Clone)]
pub struct Jobs(Arc<Shared>);

impl Jobs {
    /// Lädt offene Jobs aus `file` und startet den Worker.
    pub fn start(file: PathBuf, runner: Runner, notify: Notify) -> Jobs {
        let mut jobs: Vec<Job> = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        for j in &mut jobs {
            // lief beim Beenden: nicht wiederholen, er könnte den Absturz selbst ausgelöst haben
            if j.info.state == JobState::Running {
                j.info.state = JobState::Failed;
                j.info.message = Some("Der Daemon wurde während des Jobs beendet.".into());
            }
        }
        let next = jobs.iter().map(|j| j.info.id).max().unwrap_or(0) + 1;
        let shared = Arc::new(Shared {
            state: Mutex::new(State { jobs, next }),
            cv: Condvar::new(),
            file,
            notify,
        });
        let w = Arc::downgrade(&shared);
        std::thread::Builder::new()
            .name("dw-jobs".into())
            .spawn(move || worker(w, runner))
            .expect("Worker-Thread");
        Jobs(shared)
    }

    pub fn submit(&self, spec: JobSpec, timeout: Duration) -> u64 {
        let mut st = lock(&self.0.state);
        let id = st.next;
        st.next += 1;
        let info = JobInfo {
            id,
            kind: spec.kind().into(),
            state: JobState::Queued,
            progress: 0.0,
            message: None,
            files: vec![],
        };
        st.jobs.push(Job {
            info: info.clone(),
            spec,
            timeout_ms: timeout.as_millis() as u64,
            cancel: Arc::default(),
        });
        self.0.persist(&st);
        drop(st);
        (self.0.notify)(&info);
        self.0.cv.notify_all();
        id
    }

    /// Wartend: sofort abgebrochen; laufend: beim nächsten `Ctl::check`. false = unbekannt oder schon fertig.
    pub fn cancel(&self, id: u64) -> bool {
        let mut st = lock(&self.0.state);
        let Some(j) = st.jobs.iter_mut().find(|j| j.info.id == id) else {
            return false;
        };
        match j.info.state {
            JobState::Queued => {
                j.info.state = JobState::Cancelled;
                let info = j.info.clone();
                self.0.persist(&st);
                drop(st);
                (self.0.notify)(&info);
                true
            }
            JobState::Running => {
                j.cancel.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    }

    pub fn list(&self) -> Vec<JobInfo> {
        lock(&self.0.state)
            .jobs
            .iter()
            .map(|j| j.info.clone())
            .collect()
    }

    pub fn get(&self, id: u64) -> Option<JobInfo> {
        self.list().into_iter().find(|j| j.id == id)
    }
}

impl Shared {
    /// nur offene Jobs; Schreibfehler stoppen die Queue nicht
    fn persist(&self, st: &State) {
        let open: Vec<&Job> = st
            .jobs
            .iter()
            .filter(|j| !j.info.state.finished())
            .collect();
        let json = serde_json::to_vec(&open).unwrap_or_default();
        if let Err(e) = dw_store::write_atomic(&self.file, &json) {
            eprintln!("[dw-daemon] Jobs nicht gespeichert: {e}");
        }
    }

    fn update(&self, id: u64, f: impl FnOnce(&mut JobInfo)) {
        let mut st = lock(&self.state);
        let Some(j) = st.jobs.iter_mut().find(|j| j.info.id == id) else {
            return;
        };
        f(&mut j.info);
        let info = j.info.clone();
        if info.state.finished() {
            self.persist(&st);
            let done = st.jobs.iter().filter(|j| j.info.state.finished()).count();
            if done > KEEP_DONE {
                let mut drop_n = done - KEEP_DONE;
                st.jobs.retain(|j| {
                    let gone = drop_n > 0 && j.info.state.finished();
                    drop_n -= usize::from(gone);
                    !gone
                });
            }
        }
        drop(st);
        (self.notify)(&info);
    }
}

fn worker(shared: std::sync::Weak<Shared>, runner: Runner) {
    loop {
        // Weak: endet, sobald der Daemon (alle `Jobs`) weg ist
        let Some(s) = shared.upgrade() else { return };
        let next = {
            let st = lock(&s.state);
            let (mut st, _) =
                s.cv.wait_timeout_while(st, Duration::from_millis(500), |st| {
                    !st.jobs.iter().any(|j| j.info.state == JobState::Queued)
                })
                .unwrap_or_else(PoisonError::into_inner);
            let Some(j) = st
                .jobs
                .iter_mut()
                .find(|j| j.info.state == JobState::Queued)
            else {
                continue;
            };
            j.info.state = JobState::Running;
            let job = j.clone();
            s.persist(&st);
            job
        };
        let id = next.info.id;
        s.update(id, |_| {});
        let w = Arc::downgrade(&s);
        let ctl = Ctl {
            cancel: next.cancel.clone(),
            deadline: Instant::now() + Duration::from_millis(next.timeout_ms),
            progress: Box::new(move |p| {
                if let Some(s) = w.upgrade() {
                    s.update(id, |i| i.progress = p);
                }
            }),
        };
        // eine Panik im Job darf weder den Worker beenden noch den Job ewig auf Running lassen
        let out =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runner(&next.spec, &ctl)))
                .unwrap_or_else(|p| {
                    Outcome::Failed(format!("Absturz im Job: {}", panic_text(&*p)))
                });
        s.update(id, |i| match out {
            Outcome::Done(files, warnings) => {
                i.state = JobState::Done;
                i.progress = 1.0;
                i.files = files;
                i.message = (!warnings.is_empty()).then(|| warnings.join("\n"));
            }
            Outcome::Stopped(Stop::Cancelled) => i.state = JobState::Cancelled,
            Outcome::Stopped(Stop::TimedOut) => {
                i.state = JobState::TimedOut;
                i.message = Some(format!(
                    "Zeitlimit {} s überschritten",
                    next.timeout_ms / 1000
                ));
            }
            Outcome::Failed(e) => {
                i.state = JobState::Failed;
                i.message = Some(e);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn spec() -> JobSpec {
        JobSpec::Export {
            deck: serde_json::from_value(
                serde_json::json!({ "title": "t", "theme": { "id": "beratung" }, "slides": [] }),
            )
            .unwrap(),
            deck_dir: PathBuf::from("."),
            formats: vec![],
            out: PathBuf::from("."),
        }
    }

    fn file(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dw-jobs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join(".jobs.json")
    }

    /// Runner, der bis zum Abbruch/Timeout wartet
    fn slow() -> Runner {
        Box::new(|_, ctl| {
            loop {
                if let Err(s) = ctl.check() {
                    return Outcome::Stopped(s);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    }

    fn wait(rx: &mpsc::Receiver<JobInfo>, id: u64) -> JobInfo {
        loop {
            let i = rx.recv_timeout(Duration::from_secs(10)).expect("kein Ende");
            if i.id == id && i.state.finished() {
                return i;
            }
        }
    }

    fn start(f: PathBuf, runner: Runner) -> (Jobs, mpsc::Receiver<JobInfo>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (
            Jobs::start(
                f,
                runner,
                Box::new(move |i| drop(tx.lock().unwrap().send(i.clone()))),
            ),
            rx,
        )
    }

    #[test]
    fn abbrechen_und_timeout() {
        let f = file("cancel");
        let (jobs, rx) = start(f.clone(), slow());
        let a = jobs.submit(spec(), Duration::from_secs(60));
        let b = jobs.submit(spec(), Duration::from_secs(60));
        // b wartet noch hinter a: sofort abgebrochen
        assert!(jobs.cancel(b));
        assert_eq!(jobs.get(b).unwrap().state, JobState::Cancelled);
        while jobs.get(a).unwrap().state != JobState::Running {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(jobs.cancel(a));
        assert_eq!(wait(&rx, a).state, JobState::Cancelled);
        assert!(!jobs.cancel(a)); // schon fertig

        let c = jobs.submit(spec(), Duration::from_millis(50));
        let i = wait(&rx, c);
        assert_eq!(i.state, JobState::TimedOut);
        assert!(i.message.unwrap().contains("Zeitlimit"));
        // nichts mehr offen
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "[]");
    }

    #[test]
    fn panik_im_job_legt_queue_nicht_lahm() {
        let f = file("panic");
        let (jobs, rx) = start(
            f,
            Box::new(|spec, _| match spec {
                JobSpec::Export { formats, .. } if formats.is_empty() => panic!("kaputt"),
                _ => Outcome::Done(vec![], vec![]),
            }),
        );
        let a = jobs.submit(spec(), DEFAULT_TIMEOUT);
        let i = wait(&rx, a);
        assert_eq!(i.state, JobState::Failed);
        assert!(i.message.unwrap().contains("kaputt"));
        // der Worker lebt noch
        let JobSpec::Export {
            deck,
            deck_dir,
            out,
            ..
        } = spec();
        let b = jobs.submit(
            JobSpec::Export {
                deck,
                deck_dir,
                out,
                formats: vec![crate::ExportFormat::Png],
            },
            DEFAULT_TIMEOUT,
        );
        assert_eq!(wait(&rx, b).state, JobState::Done);
    }

    #[test]
    fn offene_jobs_ueberleben_neustart() {
        let f = file("persist");
        // Stand eines beendeten Daemons: Job 7 lief gerade, Job 8 wartete
        let job = |id, state| Job {
            info: JobInfo {
                id,
                kind: "export".into(),
                state,
                progress: 0.4,
                message: None,
                files: vec![],
            },
            spec: spec(),
            timeout_ms: 60_000,
            cancel: Arc::default(),
        };
        let open = [job(7, JobState::Running), job(8, JobState::Queued)];
        std::fs::write(&f, serde_json::to_vec(&open).unwrap()).unwrap();
        let (jobs, rx) = start(
            f,
            Box::new(|_, _| Outcome::Done(vec![PathBuf::from("x")], vec![])),
        );
        assert_eq!(wait(&rx, 8).state, JobState::Done);
        // der unterbrochene läuft nicht erneut (er könnte den Absturz ausgelöst haben)
        let seven = jobs.get(7).unwrap();
        assert_eq!(seven.state, JobState::Failed);
        assert!(seven.message.unwrap().contains("beendet"));
        assert_eq!(jobs.submit(spec(), DEFAULT_TIMEOUT), 9);
    }
}
