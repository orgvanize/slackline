var table = {};
module.exports = object;
if(!provision(process.env.DATABASE_URL)) {
	console.log('Unable to connect to database');
	process.exit(4);
}

function object(key, value) {
	if(value === undefined)
		return table[key];
	else if(value == null)
		return delete table[key];
	else if(table[key] || !value.in_workspace || !value.in_channel || !value.out_workspace
		|| !value.out_channel || !value.out_conversation || !value.out_ts)
		return false;

	table[key] = value;
	return true;
};

async function database(key, value) {
	if(value === undefined) {
		var hits = await table.query('SELECT in_workspace, in_channel, out_workspace'
			+ ', out_channel, out_conversation, out_ts FROM messages WHERE'
			+ ' in_ts = \'' + key + '\';');
		return hits.rows[0];
	} else if(value == null) {
		await table.query('DELETE FROM messages WHERE in_ts = \'' + key + '\';');
		return true;
	}

	var hits = await table.query('SELECT in_ts FROM messages WHERE in_ts = \'' + key + '\';');
	if(hits.rows.length || !value.in_workspace || !value.in_channel || !value.out_workspace
		|| !value.out_channel || !value.out_conversation || !value.out_ts)
		return false;

	await table.query('INSERT INTO messages ' + serialize(key, value) + ';');
	return true;
}

async function provision(db) {
	if(!db)
		return true;

	var pg = require('pg');
	module.exports = database;
	table = new pg.Client({
		connectionString: db,
		ssl: {
			rejectUnauthorized: false,
		},
	});
	if(await table.connect())
		return false;

	var tables = await table.query('SELECT table_name FROM information_schema.tables WHERE'
		+ ' table_name = \'messages\';');
	if(!tables.rows || !tables.rows.length) {
		console.log('Initializing database');
		await table.query('CREATE TABLE messages (in_ts TEXT PRIMARY KEY,'
			+ ' in_workspace TEXT, in_channel TEXT, out_workspace TEXT,'
			+ ' out_channel TEXT, out_conversation TEXT, out_ts TEXT);');
	}
	return true;
}

function serialize(in_ts, record) {
	return '(in_ts, in_workspace, in_channel, out_workspace, out_channel, out_conversation,'
		+ ' out_ts) VALUES (\'' + in_ts + '\', \'' + record.in_workspace + '\', \''
		+ record.in_channel + '\', \'' + record.out_workspace + '\', \''
		+ record.out_channel + '\', \'' + record.out_conversation + '\', \'' + record.out_ts
		+ '\')';
}
