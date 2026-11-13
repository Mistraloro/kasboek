// Launch window: shows that Kasboek is starting. The main process calls kasboekProgress(fraction, text).
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark')
window.kasboekProgress = function (fraction, text) {
  var pct = Math.max(4, Math.min(100, Math.round(fraction * 100)))
  document.getElementById('fill').style.width = pct + '%'
  document.querySelector('.bar').setAttribute('aria-valuenow', String(pct))
  if (text) document.getElementById('step').textContent = text
}
