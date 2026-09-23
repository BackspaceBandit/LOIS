// rc4.js — plain RC4 (KSA/PRGA) over Buffers. No deps.
function rc4(data, key) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}
module.exports = { rc4 };
