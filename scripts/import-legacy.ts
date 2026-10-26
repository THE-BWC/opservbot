import { text } from 'node:stream/consumers';
import { db } from '../src/db.ts';

// One-off at cutover, before the bot's first start (else it posts every event again):
//   mysql -N bwcsvr_opservIntegration < scripts/export-legacy.sql | pnpm import-legacy
const sql = await text(process.stdin);
db.exec(`BEGIN; ${sql} COMMIT;`);
for (const table of ['event', 'game_channel', 'setting']) {
	console.log(table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
}
