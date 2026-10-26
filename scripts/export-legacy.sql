-- Run against the legacy bot DB (bwcsvr_opservIntegration); prints SQLite statements for import-legacy.ts.
-- V10 keeps V9 operation and game ids, so the rows carry over as they are.
SELECT CONCAT('INSERT OR REPLACE INTO event VALUES (', operation_id, ', ''', event_id, ''', NULL);')
FROM discord_events
UNION ALL
SELECT CONCAT('INSERT OR REPLACE INTO game_channel VALUES (', id, ', ''', channel_id, ''');')
FROM game_channel
UNION ALL
SELECT CONCAT('INSERT OR REPLACE INTO setting VALUES (''announcement_channel'', ''', announcement_channel, ''');')
FROM guild WHERE announcement_channel IS NOT NULL
UNION ALL
SELECT CONCAT('INSERT OR REPLACE INTO setting VALUES (''log_channel'', ''', log_channel, ''');')
FROM guild WHERE log_channel IS NOT NULL;
