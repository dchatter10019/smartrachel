// Why a fetch / SDK connection failed: "fetch failed" and the SDK's "Connection error." hide the socket error in
// e.cause (often nested). Oct 30: ~8 QA turns a night hit dropped connections and no log said why.
function causeOf(e) {
  const parts = [];
  for (let c = e && e.cause, i = 0; c && i < 4; c = c.cause, i++) {
    parts.push([c.code, c.syscall, c.address && c.address + (c.port ? ':' + c.port : ''), c.message].filter(Boolean).join(' '));
    if (Array.isArray(c.errors)) parts.push(c.errors.map(x => [x.code, x.address, x.message].filter(Boolean).join(' ')).join(' | '));
  }
  return parts.join(' <- ').slice(0, 300) || 'no cause given';
}
module.exports = { causeOf };
