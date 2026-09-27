// Einstieg: erst den Splash aus index.html malen lassen, dann das große Bundle laden.
// Offscreen-Hosts (#render/#print/#overview) sind unsichtbar und bekommen evtl. nie einen Frame → sofort laden; render.ts wartet auf window.dw.
if (['#render', '#print', '#overview'].includes(location.hash)) import('./main')
else requestAnimationFrame(() => setTimeout(() => import('./main')))
