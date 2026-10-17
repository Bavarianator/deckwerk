# Parakeet Ultra (moondream, CC-BY-4.0) ins sherpa-onnx-Format: läuft im Workflow .github/workflows/modelle.yml, nicht auf dem PC
# (NeMo + Torch, ~10 GB RAM). Ultra ist parakeet-tdt-0.6b-v3 nachtrainiert, gleiche Architektur und Tokenizer, aber nur als
# Hugging-Face-Checkpoint (transformers ParakeetForTDT). Die Gewichte kommen über die Schlüsselzuordnung aus transformers'
# convert_nemo_to_hf.py zurück in NVIDIAs .nemo; dieselbe Zuordnung muss NVIDIAs eigenen HF-Checkpoint bitgenau auf die .nemo
# abbilden, sonst bricht das Skript ab. Export und int8 wie sherpa-onnx scripts/nemo/parakeet-tdt-0.6b-v3/export_onnx.py.
import hashlib
import re
import sys

import nemo.collections.asr as nemo_asr
import onnx
import torch
from huggingface_hub import hf_hub_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from safetensors.torch import load_file

# feste Stände + Prüfsummen
NV = ('nvidia/parakeet-tdt-0.6b-v3', '541d1f99c6b0c3cd0b11a95167540bb8edefd82b')
NV_NEMO = ('parakeet-tdt-0.6b-v3.nemo', '3cbdc85877e668ca7b82d0d56770eb1fac76691f55d6b97545e8d61ca588d10d')
NV_HF = ('model.safetensors', '3a2026366188c8c68598edbbff92f8d11590a08e0ae2e6775544e7b07d6a5e11')
ULTRA = ('moondream/parakeet-ultra', '73175eb7aeb0d82f1e2a6b53b3aabc10a90bcd0b')
ULTRA_HF = ('model.safetensors', 'c9608f36d0ab956c14bfcc525479b0746b3b42a56f6949ec85c14eb7466717dc')

# transformers/models/parakeet/convert_nemo_to_hf.py: NEMO_TO_HF_WEIGHT_MAPPING + NEMO_TDT_WEIGHT_MAPPING, in dieser Reihenfolge
MAPPING = {
    r"encoder\.pre_encode\.conv\.": r"encoder.subsampling.layers.",
    r"encoder\.pre_encode\.out\.": r"encoder.subsampling.linear.",
    r"encoder\.pos_enc\.": r"encoder.encode_positions.",
    r"encoder\.layers\.(\d+)\.conv\.batch_norm\.": r"encoder.layers.\1.conv.norm.",
    r"decoder\.decoder_layers\.0\.(weight|bias)": r"ctc_head.\1",
    r"linear_([kv])": r"\1_proj",
    r"linear_out": r"o_proj",
    r"linear_q": r"q_proj",
    r"pos_bias_([uv])": r"bias_\1",
    r"linear_pos": r"relative_k_proj",
    r"decoder\.prediction\.embed\.": r"decoder.embedding.",
    r"decoder\.prediction\.dec_rnn\.lstm\.": r"decoder.lstm.",
    r"joint\.enc\.": r"encoder_projector.",
    r"joint\.pred\.": r"decoder.decoder_projector.",
    r"joint\.joint_net\.2\.": r"joint.head.",
}


def hf_key(k):
    for a, b in MAPPING.items():
        k = re.sub(a, b, k)
    return k


def fetch(repo, name):
    path = hf_hub_download(repo[0], name[0], revision=repo[1])
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    if h.hexdigest() != name[1]:
        sys.exit(f'Prüfsumme falsch: {repo[0]}/{name[0]}')
    return path


def mapped(sd, hf, check):
    """NeMo-State-Dict aus einem HF-Checkpoint; check: jeder Tensor muss bitgleich sein (Zuordnung prüfen)"""
    out, used = {}, set()
    for k, v in sd.items():
        if k.endswith('featurizer.window') or k.endswith('featurizer.fb'):  # Vorverarbeitung, nicht im HF-Checkpoint
            out[k] = v
            continue
        h = hf_key(k)
        if h not in hf:
            sys.exit(f'fehlt im HF-Checkpoint: {k} -> {h}')
        t = hf[h].to(v.dtype)
        if t.shape != v.shape:
            sys.exit(f'Form passt nicht: {k} {tuple(t.shape)} != {tuple(v.shape)}')
        if check and not torch.equal(t, v):
            sys.exit(f'nicht bitgleich: {k}')
        out[k] = t
        used.add(h)
    return out, sorted(set(hf) - used)


@torch.no_grad()
def main():
    model = nemo_asr.models.ASRModel.restore_from(fetch(NV, NV_NEMO), map_location='cpu')
    model.eval()
    sd = {k: v.clone() for k, v in model.state_dict().items()}  # Kopie: state_dict() teilt den Speicher mit dem Modell
    _, rest = mapped(sd, load_file(fetch(NV, NV_HF)), check=True)
    print(f'Zuordnung geprüft: {len(sd)} Tensoren der .nemo bitgleich aus NVIDIAs HF-Checkpoint, übrig: {rest}')
    ultra, rest = mapped(sd, load_file(fetch(ULTRA, ULTRA_HF)), check=False)
    if any(not k.startswith('vad_head.') for k in rest):
        sys.exit(f'unbekannte Ultra-Tensoren: {rest}')
    print(f'Ultra: {len(ultra)} Tensoren, verworfen (nicht in NeMo): {rest}')
    model.load_state_dict(ultra, strict=True)
    changed = sum(not torch.equal(ultra[k], v) for k, v in sd.items())
    print(f'gegenüber v3 geändert: {changed} Tensoren')

    with open('tokens.txt', 'w', encoding='utf-8') as f:
        for i, s in enumerate(model.joint.vocabulary):
            f.write(f'{s} {i}\n')
        f.write(f'<blk> {i + 1}\n')
    model.encoder.export('encoder.onnx')
    model.decoder.export('decoder.onnx')
    model.joint.export('joiner.onnx')
    normalize = model.cfg.preprocessor.normalize
    meta = {
        'vocab_size': model.decoder.vocab_size, 'normalize_type': '' if normalize == 'NA' else normalize,
        'pred_rnn_layers': model.decoder.pred_rnn_layers, 'pred_hidden': model.decoder.pred_hidden,
        'subsampling_factor': 8, 'model_type': 'EncDecRNNTBPEModel', 'version': '2',
        'model_author': 'moondream (fine-tune of NVIDIA parakeet-tdt-0.6b-v3)',
        # sherpa-onnx erkennt TDT am Teilstring „tdt“ in url
        'url': 'https://huggingface.co/moondream/parakeet-ultra (parakeet-tdt-0.6b-v3 architecture)',
        'comment': 'Only the transducer branch is exported. License CC-BY-4.0', 'feat_dim': 128,
    }
    for m in ['encoder', 'decoder', 'joiner']:
        quantize_dynamic(model_input=f'{m}.onnx', model_output=f'{m}.int8.onnx', weight_type=QuantType.QUInt8 if m == 'encoder' else QuantType.QInt8)
    enc = onnx.load('encoder.int8.onnx')
    del enc.metadata_props[:]
    for k, v in meta.items():
        p = enc.metadata_props.add()
        p.key, p.value = k, str(v)
    onnx.save(enc, 'encoder.int8.onnx')
    print('meta', meta)


if __name__ == '__main__':
    main()
