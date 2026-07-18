// Dump the daemon's /debug: did the tap reach the daemon and where did it route?
import { readSecret, BASE_URL } from './shared.ts'
const r = await fetch(`${BASE_URL}/debug`, { headers: { 'x-bridge-secret': readSecret() } })
const j = await r.json()
console.log('polling:', j.polling, '| lastPollError:', j.lastPollError || '-')
console.log('sessions:', JSON.stringify(j.sessions))
console.log(`--- recentInbound (${j.recentInbound.length}) ---`)
for (const e of j.recentInbound) console.log(JSON.stringify(e))
