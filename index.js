const http = require('http');
const https = require('https');
const messages = require('./messages');

const cache = {
	lines: {},
	line: function(workspace, channel, quiet) {
		var id = workspace + '#' + channel;
		if(!this.lines[id]) {
			var iable = 'LINE_' + workspace + '_' + channel;
			var other = process.env[iable];
			if(!other) {
				if(!quiet)
					console.log('Environment is missing $' + iable);
				return null;
			}

			other = other.split('#');
			if(other.length != 2) {
				console.log('Environment variable $' + iable + ' is not #-delimited');
				return null;
			}
			this.lines[id] = {
				workspace: other[0],
				channel: other[1],
			};
		}
		return this.lines[id];
	},
	tokens: {},
	token: function(workspace) {
		if(!workspace)
			return null;

		workspace = workspace.split('#');
		if(workspace.length > 2)
			return null;
		else if(workspace.length == 2)
			this.tokens[workspace[0]] = workspace[1];
		return this.tokens[workspace[0]]
	},

	channels: {},
	users: {},
	teams: {},
	workspaces: {},
	channel: function(id, workspace) {
		return cached(this.channels, id, 'conversations.info', 'channel', 'name', workspace);
	},
	user: async function(id, workspace) {
		var profile = await cached(this.users, id, 'users.info', 'user', 'profile', workspace);
		if(!profile)
			return profile;
		return {
			name: profile.real_name,
			avatar: profile.image_512,
		};
	},
	team: function(chanid) {
		return this.teams[chanid];
	},
	workspace: function(id) {
		return cached(this.workspaces, id, 'team.info', 'team', 'domain');
	},

	bootstrap: async function(token) {
		token = this.token(process.env['TOKEN_' + index]);
		if(!token)
			return false;

		var workspace = await call('team.info', null, token);
		if(!workspace || !workspace.ok)
			return workspace;
		this.workspaces[workspace.team.id] = workspace.team.domain;

		var channels = await call('conversations.list?types=public_channel,private_channel', null, token);
		if(!channels.ok)
			console.log('Missing OAuth scope channels:read and/or groups:read?');
		for(var channel of channels.channels)
			if(this.line(workspace.team.domain, channel.name, true))
				this.teams[channel.id] = workspace.team.id;

		return true;
	},
};
const dedup = {};

const PORT = process.env.PORT;
if(!PORT) {
	console.log('Environment is missing $PORT');
	process.exit(1);
}

const TOKEN_0 = cache.token(process.env.TOKEN_0);
if(!TOKEN_0) {
	console.log('Environment is missing $TOKEN_0 or it is not #-delimited');
	process.exit(2);
}
for(var index = 0; process.env['TOKEN_' + index]; ++index)
	if(!cache.bootstrap(process.env['TOKEN_' + index])) {
		console.log('Failed to authenticate with token ' + index);
		process.exit(3);
	}

http.createServer(handle_connection).listen(PORT);

async function cached(memo, key, method, parameter, argument, workspace) {
	if(!memo[key]) {
		var lookup = await call(method + '?' + parameter + '=' + key, null, workspace);
		if(!lookup || !lookup.ok) {
			console.log('Failed to cache API response: ' + JSON.stringify(lookup));
			return null;
		}
		memo[key] = lookup[parameter][argument];
	}
	return memo[key];
}

function call(method, body, workspace) {
	var token = cache.token(workspace);
	if(!token)
		token = workspace;
	if(!token)
		token = TOKEN_0;

	var header = {
		headers: {
			Authorization: 'Bearer ' + token,
		},
	};
	var payload = '';
	if(body) {
		header.method = 'POST';
		header.headers['Content-Type'] = 'application/json';
		payload = JSON.stringify(body);
	}

	var request = https.request('https://slack.com/api/' + method, header);
	var response = new Promise(function(resolve) {
		request.on('response', async function(res) {
			resolve(JSON.parse(await stringify(res)));
		});
	});
	request.end(payload);
	return response;
}

function stringify(stream) {
	return new Promise(function(resolve) {
		var chunks = [];
		stream.setEncoding('utf8');
		stream.on('data', function(chunk) {
			chunks.push(chunk);
		});
		stream.on('end', function() {
			resolve(chunks.join(''));
		});
	});
}

async function replace(string, regex, async_func) {
	var futures = [];
	string.replace(regex, function(...args) {
		futures.push(async_func(...args));
	});

	var strings = await Promise.all(futures);
	return string.replace(regex, function() {
		return strings.shift();
	});
}

function process_users(workspace, message) {
	return replace(message, /<@([A-Z0-9]+)>/g, async function(orig, user) {
		user = await cache.user(user, workspace);
		if(user)
			return '@' + user.name;
		return orig;
	});
}

async function handle_connection(request, response) {
	var payload = await stringify(request);
	if(dedup[payload]) {
		console.log('Acknowledging duplicate request');
		return response.end();
	}
	dedup[payload] = true;

	if(!payload) {
		console.log('Empty request payload');
		return response.end('Empty request payload');
	}
	payload = JSON.parse(payload);

	switch(payload.type) {
	case 'event_callback':
		if(!payload.event) {
			console.log('event_callback without associated event in payload: ' + payload);
			return response.end('event_callback without associated event');
		}
		handle_event(payload.event);
		return response.end();
	case 'url_verification':
		return response.end(payload.challenge);
	default:
		console.log('Unhandled request type in payload: ' + payload);
		return response.end('Unhandled request type: \'' + payload.type + '\'');
	}
}

async function handle_event(event) {
	if(event.type != 'message') {
		console.log('unhandled type in event: ' + event);
		return;
	} else if(event.bot_id || (event.message && event.message.bot_id))
		return;
	console.log(event);

	var team = event.team;
	if(event.subtype == 'message_deleted') {
		var copy = await messages(event.deleted_ts);
		if(copy) {
			console.log(await call('chat.delete', {
				channel: copy.out_conversation,
				ts: copy.out_ts,
			}, copy.out_workspace));
			await messages(event.deleted_ts, null);
			await messages(copy.out_ts, null);
		}
		return;
	} else if(event.subtype == 'message_changed') {
		var copy = await messages(event.message.ts);
		if(copy) {
			var message = {
				channel: copy.out_conversation,
				ts: copy.out_ts,
				text: event.message.text,
			};
			if(event.message.user)
				await cache.user(event.message.user, workspace);
			message.text = await process_users(workspace, message.text);
			console.log(await call('chat.update', message, copy.out_workspace));
		}
		return;
	} else if(event.subtype == 'thread_broadcast')
		team = cache.team(event.channel);

	var workspace = await cache.workspace(team);
	var channel = await cache.channel(event.channel, workspace);
	var paired = cache.line(workspace, channel);
	if(!workspace || !channel || !paired)
		return;

	var message = {
		channel: paired.channel,
		text: event.text,
	};
	if(event.thread_ts) {
		var copy = await messages(event.thread_ts);
		console.log(copy);
		if(copy) {
			message.thread_ts = copy.out_ts;
			if(event.subtype == 'thread_broadcast')
				message.reply_broadcast = true;
		}
	}

	var user = await cache.user(event.user, workspace);
	if(user) {
		message.username = user.name;
		message.icon_url = user.avatar;

		message.text = await process_users(workspace, message.text);
	}

	var ack = await call('chat.postMessage', message, paired.workspace);
	console.log(ack);
	await messages(event.ts, {
		in_workspace: workspace,
		in_channel: channel,
		out_workspace: paired.workspace,
		out_channel: paired.channel,
		out_conversation: ack.channel,
		out_ts: ack.ts,
	});
	await messages(ack.ts, {
		in_workspace: paired.workspace,
		in_channel: paired.channel,
		out_workspace: workspace,
		out_channel: channel,
		out_conversation: event.channel,
		out_ts: event.ts,
	});
}
