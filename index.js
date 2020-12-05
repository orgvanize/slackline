// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Copyright (C) 2020, Sol Boucher
// Copyright (C) 2020, The Vanguard Campaign Corps Mods (vanguardcampaign.org)

const http = require('http');
const https = require('https');
const messages = require('./messages');
const querystring = require('querystring');

const cache = {
	lines: {},
	line: function(workspace, channel, quiet = false) {
		var id = workspace + '#' + channel;
		if(!this.lines[id]) {
			var iable = 'LINE_' + escaped(workspace) + '_' + escaped(channel);
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
	uids: {},
	users: {},
	teams: {},
	workspaces: {},
	channel: function(id, workspace) {
		return cached(this.channels, id, 'conversations.info', 'channel', 'name', workspace);
	},
	uid: function(name, channel, workspace) {
		var user = this.uids[workspace + '#' + channel + '#' + name];
		if(user)
			return user;
		return Object.keys(this.uids).filter(function(each) {
			return each.startsWith(workspace + '#' + channel + '#');
		}).map(function(each) {
			return each.replace(/.*#/, '');
		}).sort();
	},
	user: async function(id, channel, workspace, update = true) {
		var profile = await cached(this.users, id, 'users.info', 'user', 'profile', workspace, update);
		if(!profile)
			return profile;

		if(update)
			this.uids[workspace + '#' + channel + '#' + profile.real_name] = id;
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

	dms: {},
	ims: {},
	dm: function(uid) {
		var dm = this.dms[uid];
		if(!dm) {
			dm = {};
			this.dms[uid] = dm;
		}
		return dm;
	},
	im: async function(uid, workspace) {
		var im = this.ims[workspace]
		if(im)
			im = im[uid];
		if(!im) {
			var channels = await collect_call('conversations.list?types=im',
				null, 'channels', workspace);
			if(!channels)
				console.log('Missing OAuth scope im:read?');

			var ims = {}
			for(var channel of channels)
				ims[channel.user] = channel.id;
			this.ims[workspace] = ims;
			im = ims[uid];
		}
		return im;
	},

	bootstrap: async function(token) {
		token = this.token(token);
		if(!token)
			return false;

		var workspace = await call('team.info', null, token);
		if(!workspace || !workspace.ok)
			return workspace;
		this.workspaces[workspace.team.id] = workspace.team.domain;

		var channels = await collect_call('conversations.list?types=public_channel,private_channel',
			null, 'channels', token);
		if(!channels)
			console.log('Missing OAuth scope channels:read and/or groups:read?');
		for(var channel of channels)
			if(this.line(workspace.team.domain, channel.name, true)) {
				this.teams[channel.id] = workspace.team.id;

				var members = await collect_call('conversations.members?channel=' + channel.id,
					null, 'members', token);
				for(var member of members)
					await this.user(member, channel.name, workspace.team.domain);
			}

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
	console.log('Only URL verification is supported in this configuration');
}
for(var index = 0; process.env['TOKEN_' + index]; ++index)
	if(!cache.bootstrap(process.env['TOKEN_' + index])) {
		console.log('Failed to authenticate with token ' + index);
		process.exit(2);
	}

http.createServer(handle_connection).listen(PORT);

async function cached(memo, key, method, parameter, argument, workspace, update = true) {
	if(!memo[key]) {
		var lookup = await call(method + '?' + parameter + '=' + key, null, workspace);
		if(!lookup || !lookup.ok) {
			console.log('Failed to cache API response: ' + JSON.stringify(lookup));
			console.trace();
			return null;
		}
		if(update)
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

async function collect_call(method, body, array, workspace) {
	var collected = [];
	var cursor = '';
	var delim = '?';
	if(method.indexOf('?') != -1)
		delim = '&';
	do {
		var it = await call(method + cursor, body, workspace);
		if(!it.ok)
			return null;

		collected = collected.concat(it[array]);
		if(it.response_metadata && it.response_metadata.next_cursor) {
			cursor = it.response_metadata.next_cursor;
			cursor = delim + 'cursor=' + cursor.replace(/=/g, '%3D');
		} else
			cursor = '';
	} while(cursor);
	return collected;
}

function escaped(varname) {
	return varname.replace(/-/g, '__hyphen__');
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

async function process_users(in_workspace, in_channel, in_user, message, out_workspace, out_channel) {
	if(message.startsWith('@') || message.search(/[^<`]@/) != -1)
		await warning(in_workspace, in_channel, in_user,
			'*Warning:* If you want to tag someone in the bridged channel,'
			+ ' you must enclose the mention in backticks (e.g., `@Their Name`).'
			+ '\n_Edit your message if you wish to notify people!_');

	var locals = {};
	message = await replace(message, /<@([A-Z0-9]+)>/g, async function(orig, user) {
		// Skip updating cache because it is possible to mention a user not in the channel!
		user = await cache.user(user, in_channel, in_workspace, false);
		if(user) {
			locals[user.name] = true;
			return '`@' + user.name + '`';
		}
		return orig;
	});

	var mismatches = [];
	message = await replace(message, /`@([^`]*)`/g, async function(orig, user) {
		var uid = await cache.uid(user, out_channel, out_workspace);
		if(!Array.isArray(uid))
			return '<@' + uid + '>';

		mismatches.push(user);
		return orig;
	});

	mismatches = mismatches.filter(function(each) {
		return !locals[each];
	});
	if(mismatches.length)
		await warning(in_workspace, in_channel, in_user,
			'*Warning:* Could not find anyone by the name(s) \''
			+ mismatches.join('\', \'') + '\'!'
			+ '\nMaybe you meant one of these people:'
			+ '\n' + await list_users(out_workspace, out_channel) + '\n'
			+ '_If so, edit your message so they will be notified!_');

	return message;
}

async function list_users(workspace, channel) {
	var users = await cache.uid('', channel, workspace);
	return '`@' + users.join('`\n`@') + '`';
}

function warning(workspace, channel, user, text) {
	return call('chat.postEphemeral', {
		channel: channel,
		user: user,
		text: text,
	}, workspace);
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

	if(payload.startsWith('{'))
		payload = JSON.parse(payload);
	else
		payload = querystring.parse(payload);

	switch(payload.type) {
	case undefined:
		return response.end(await handle_command(payload));
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

async function handle_command(payload) {
	var command = payload.text.replace(/\s.*/, '');
	var args = payload.text.replace(/\S+\s*/, '');
	var error = '';
	switch(command) {
	case 'dm':
	case 'list':
		var channel = payload.channel_name;
		if(args && command == 'list')
			channel = args;

		var argv = args.split(' - ');
		args = argv[0];
		if(argv.length > 1)
			channel = argv[1];
		else if(payload.channel_name == 'directmessage')
			if(!(channel = cache.dm(payload.user_id).in_channel))
				channel = '';

		var paired = await cache.line(payload.team_domain, channel);
		if(!paired) {
			channel = channel.replace(/group$/, '');
			paired = await cache.line(payload.team_domain, channel);
		}
		if(!paired && channel)
			return '*Error:* Unpaired channel: \'' + channel + '\'';
		if(command == 'list')
			return 'Members bridged with channel \'' + channel + '\':\n'
				+ await list_users(paired.workspace, paired.channel);
		else if(!args)
			return '*Error:* You must specify a user to direct message!\n'
				+ '_See_ *' + payload.command + ' help*.';
		else if(!channel)
			return '*Error:* Please specify which channel the user is from!\n'
				+ '_See_ *' + payload.command + ' help*.';

		var uid = await cache.uid(args, paired.channel, paired.workspace);
		if(Array.isArray(uid))
			return '*Error:* Could not find anyone by the name \''
				+ args + '\'!'
				+ '\nMaybe you meant one of these people:\n'
				+ (await list_users(paired.workspace, paired.channel)).replace(/@/g, '');

		var dm = cache.dm(payload.user_id);
		dm.out_workspace = paired.workspace;
		dm.in_channel = channel;
		dm.uid = uid;
		warning(payload.team_domain, payload.user_id, payload.user_id,
			'You are now DM\'ing `@' + args + '` from #' + channel + '.\n'
			+ '_To change this, use_ *' + payload.command + ' dm* _at any time._');
		return '';

	default:
		error = '*Error:* Unrecognized command: \'' + command + '\'\n';
	case 'help':
		error += 'Supported commands:\n*'
			+ payload.command + ' help*: Show this help\n*'
			+ payload.command + ' list [channel]*: List bridged members of current channel (or specified [channel])\n*'
			+ payload.command + ' dm <user> [- channel]*: Direct message specified <user> (bridged via [channel])';
		return error;
	}
}

async function handle_event(event) {
	if(event.type == 'member_joined_channel') {
		handle_join(event);
		return;
	} else if(event.type == 'reaction_added') {
		if(await messages(event.item.ts)) {
			var workspace = await cache.workspace(cache.team(event.item.channel));
			warning(workspace, event.item.channel, event.user,
				'*Warning:* Emoji reactions are currently unsupported.'
				+ '\n_If you want the other channel to see, send an emoji message!_');
		}
		return;
	} else if(event.subtype == 'file_share') {
		var workspace = await cache.workspace(cache.team(event.channel));
		warning(workspace, event.channel, event.user,
			'*Warning:* File uploads are currently unsupported.'
			+ '\n_If you want the other channel to see, link to cloud storage instead!_');
	} else if(event.type != 'message') {
		console.log('unhandled type in event: ' + JSON.stringify(event));
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
				await cache.user(event.message.user, copy.in_channel, copy.in_workspace);
			message.text = await process_users(copy.in_workspace, copy.in_channel, event.message.user,
				message.text, copy.out_workspace, copy.out_channel);
			console.log(await call('chat.update', message, copy.out_workspace));
		}
		return;
	} else if(event.subtype && (event.subtype == 'thread_broadcast'
		|| event.subtype.endsWith('_join') || event.subtype.endsWith('_leave')
		|| event.subtype == 'file_share'))
		team = cache.team(event.channel);

	var workspace = await cache.workspace(team);
	var channel;
	var paired;
	if(event.channel_type == 'im') {
		var dm = cache.dm(event.user);
		if(dm.uid) {
			channel = dm.in_channel;
			paired = {
				workspace: dm.out_workspace,
				channel: await cache.im(dm.uid, dm.out_workspace),
			};
		} else {
			console.log(await call('reactions.add', {
				channel: event.channel,
				timestamp: event.ts,
				name: 'warning',
			}, workspace));
			warning(workspace, event.channel, event.user,
				'*Error:* You must specify a user to direct message!\n'
				+ '_For help: click my avatar, choose an option beginning with \'/\', and hit send._');
			return;
		}
	} else {
		channel = await cache.channel(event.channel, workspace);
		paired = cache.line(workspace, channel);
	}
	if(!workspace || !channel || !paired)
		return;

	var message = {
		channel: paired.channel,
		text: event.text,
	};
	if(event.attachments)
		message.attachments = event.attachments;
	if(event.thread_ts) {
		var copy = await messages(event.thread_ts);
		console.log(copy);
		if(copy) {
			message.thread_ts = copy.out_ts;
			if(event.subtype == 'thread_broadcast')
				message.reply_broadcast = true;
		}
	}

	var user = await cache.user(event.user, channel, workspace);
	if(user) {
		message.username = user.name;
		message.icon_url = user.avatar;

		message.text = await process_users(workspace, channel, event.user,
			message.text, paired.workspace, paired.channel);
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

async function handle_join(event) {
	var workspace = await cache.workspace(event.team);
	var channel = await cache.channel(event.channel, workspace);
	await cache.user(event.user, channel, workspace);
}
