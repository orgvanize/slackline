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

const fs = require('fs');
const http = require('http');
const https = require('https');
const messages = require('./messages');
const querystring = require('querystring');

const README = 'README';
const USERMANUAL = 'User instructions';

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

		var store = this.uids;
		return Object.keys(this.uids).filter(function(each) {
			return each.startsWith(workspace + '#' + channel + '#') && store[each];
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
	unuser: async function(id, channel, workspace) {
		this.uids[workspace + '#' + channel + '#' + (await this.user(id)).name] = undefined;
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
	dmers: function(uid) {
		var dmers = [];
		for(var dmer in this.dms)
			if(this.dms[dmer].uid == uid)
				dmers.push(dmer);
		return dmers;
	},
	im: async function(uid, workspace, init) {
		var ims = this.ims[workspace]
		if(!ims) {
			ims = {};
			this.ims[workspace] = ims;
		}

		if(ims[uid])
			return ims[uid];
		else if(init) {
			ims[uid] = init;
			return init;
		} else {
			var channels = await collect_call('conversations.list?types=im',
				null, 'channels', workspace);
			if(!channels) {
				console.log('Workspace \'' + workspace
					+ '\' missing OAuth scope im:read (' + uid  + ')?');
				return null;
			}

			for(var channel of channels)
				if(!ims[channel.user])
					ims[channel.user] = channel.id;
			return ims[uid];
		}
	},
	imer: function(imid, workspace) {
		var ims = this.ims[workspace];
		if(!ims)
			return null;
		for(var uid in ims)
			if(ims[uid] == imid)
				return uid;
		return null;
	},

	bootstrap: async function(token) {
		token = this.token(token);
		if(!token)
			return false;

		var workspace = await call('team.info', null, token);
		if(!workspace || !workspace.ok)
			return workspace;
		this.workspaces[workspace.team.id] = workspace.team.domain;

		var channels = await collect_call('conversations.list?types=public_channel,private_channel,im',
			null, 'channels', token);
		if(!channels) {
			console.log('Missing OAuth scope channels:read, groups:read, and/or im:read?');
			return false;
		}

		for(var channel of channels)
			if(channel.is_im || this.line(workspace.team.domain, channel.name, true)) {
				this.teams[channel.id] = workspace.team.id;

				var members = await collect_call('conversations.members?channel=' + channel.id,
					null, 'members', token);
				if(channel.is_im)
					await this.im(channel.user, workspace.team.domain, channel.id);
				else
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

const LOGGING = process.env.LOGGING != undefined;

const TOKEN_0 = cache.token(process.env.TOKEN_0);
if(!TOKEN_0) {
	console.log('Environment is missing $TOKEN_0 or it is not #-delimited');
	console.log('Only URL verification is supported in this configuration');
}
bootstrap();

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

async function process_users(in_workspace, in_channel, in_user, message, out_workspace, out_channel, display) {
	if(message.startsWith('@') || message.search(/[^<`]@/) != -1)
		warning(in_workspace, display, in_user,
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
	if(typeof out_channel == 'string')
		message = await replace(message, /`@([^`]*)`/g, async function(orig, user) {
			var uid = await cache.uid(user, out_channel, out_workspace);
			if(!Array.isArray(uid))
				return '<@' + uid + '>';

			mismatches.push(user);
			return orig;
		});
	else
		message = await replace(message, /`@([^`]*)`/g, async function(orig, user) {
			var uid = out_channel[user];
			if(uid)
				return '<@' + uid + '>';

			return orig;
		});

	mismatches = mismatches.filter(function(each) {
		return !locals[each];
	});
	if(mismatches.length)
		warning(in_workspace, display, in_user,
			'*Warning:* Could not find anyone by the name(s) \''
			+ mismatches.join('\', \'') + '\'!'
			+ '\nMaybe you meant one of these people:'
			+ '\n' + await list_users(out_workspace, out_channel) + '\n'
			+ '_If so, edit your message so they will be notified!_');

	return message;
}

async function process_args(in_workspace, in_channel, args) {
	args = await replace(args, /<#([^|>]*)(|[^>]*)?>/, async function(orig, cid, cname) {
		var channel = await cache.channel(cid, in_workspace);
		if(channel) {
			in_channel = channel;
			return channel;
		}

		return cname.substring(1);
	});
	args = args.replace(/#(\S*)/, function(orig, cname) {
		in_channel = cname;
		return cname;
	});
	if(!in_channel)
		return args;

	args = await replace(args, /<@([^|>]*)(|[^>]*)?>/g, async function(orig, uid, uname) {
		var user = await cache.user(uid, in_channel, in_workspace, false);
		if(user)
			return user.name;

		return uname.substring(1);
	});
	args = args.replace(/`?@([^\`]*)`?/g, function(orig, uname) {
		return uname;
	});

	return args;
}

async function list_users(workspace, channel) {
	var users = await cache.uid('', channel, workspace);
	return '`@' + users.join('`\n`@') + '`';
}

async function is_member(workspace, channel, uid) {
	return !Array.isArray(cache.uid(
		(await cache.user(uid, channel, workspace, false)).name,
		channel, workspace));
}

async function select_user(dmer, in_workspace, in_channel, out_workspace, dmee, command) {
	var dm = cache.dm(dmer);
	dm.out_workspace = out_workspace;
	dm.in_channel = in_channel;
	dm.uid = dmee;
	if(command)
		dm.command = command;

	var cleaned = await clean_channel(in_workspace, dmer)
	var user = await cache.user(dmee, cache.line(in_workspace, in_channel), out_workspace);
	await call('chat.postMessage', {
		channel: dmer,
		text: 'You are now DM\'ing `@' + user.name + '` from #' + in_channel + '.',
	}, in_workspace);

	if(!cleaned && dm.command)
		warning(in_workspace, dmer, dmer,
			'_To change this, use_ *' + dm.command + ' dm* _at any time._');
}

async function clean_channel(workspace, user) {
	var modified = false;
	var convo = await cache.im(user, workspace);
	var latest;
	await call('conversations.history?channel=' + convo + '&limit=1', null, workspace);
	while((latest = (await call('conversations.history?channel='
		+ convo + '&limit=1', null, workspace)).messages)
		&& (latest = latest[0]) && latest.bot_id && !latest.username) {
		await call('chat.delete', {
			channel: user,
			ts: latest.ts,
		}, workspace);
		modified = true;
	}
	return modified;
}

function warning(workspace, channel, user, text) {
	return call('chat.postEphemeral', {
		channel: channel,
		user: user,
		text: text,
	}, workspace);
}

async function bootstrap() {
	for(var index = 0; process.env['TOKEN_' + index]; ++index)
		if(!await cache.bootstrap(process.env['TOKEN_' + index]))
			console.log('Failed to authenticate with token ' + index);

	http.createServer(handle_connection).listen(PORT);
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
	var channel;
	if(payload.channel_name == 'directmessage') {
		if(!(channel = cache.dm(payload.user_id).in_channel))
			channel = '';
	} else
		channel = await cache.channel(payload.channel_id, payload.team_domain);

	var args = await process_args(payload.team_domain, channel, payload.text.replace(/\S+\s*/, ''));
	var explicitchannel;
	var error = '';
	switch(command) {
	case 'dm':
		var argv = args.match(/(.*) - (.*)/);
		if(argv) {
			explicitchannel = channel;
			args = argv[1];
			channel = argv[2];
		}
	case 'list':
		if(command == 'list' && args)
			channel = args;
		if(!channel)
			return '*Error:* You must specify a bridged channel (could not infer it)!\n'
				+ '_See_ *' + payload.command + ' help*.';

		var paired = await cache.line(payload.team_domain, channel, true);
		if(!paired && explicitchannel) {
			// Maybe the user has a ' - ' in their name? Fall back to channel inference.
			args += ' - ' + channel;
			channel = explicitchannel;
			paired = await cache.line(payload.team_domain, channel, true);
		}
		if(!paired) {
			if(command == 'dm') {
				cache.dm(payload.user_id).uid = undefined;
				await clean_channel(payload.team_domain, payload.user_id);
			}
			return '*Error:* The channel \'' + channel + '\' is not bridged!';
		} else if(!await is_member(payload.team_domain, channel, payload.user_id)) {
			if(command == 'dm') {
				cache.dm(payload.user_id).uid = undefined;
				await clean_channel(payload.team_domain, payload.user_id);
			}
			return '*Error:* You are not a member of channel \'' + channel + '\'!';
		}

		if(command == 'list')
			return 'Members bridged with channel \'' + channel + '\':\n'
				+ await list_users(paired.workspace, paired.channel);

		if(!args) {
			cache.dm(payload.user_id).uid = undefined;
			await clean_channel(payload.team_domain, payload.user_id);
			return '*Error:* You must specify a user to direct message!\n'
				+ '_See_ *' + payload.command + ' help* (on the *dm* command).';
		}

		var uid = await cache.uid(args, paired.channel, paired.workspace);
		if(Array.isArray(uid)) {
			cache.dm(payload.user_id).uid = undefined;
			await clean_channel(payload.team_domain, payload.user_id);
			return '*Error:* Could not find anyone by the name \''
				+ args + '\' bridged with channel \'' + channel + '\'!'
				+ '\nMaybe you meant one of these people:\n'
				+ await list_users(paired.workspace, paired.channel);
		}

		select_user(payload.user_id, payload.team_domain, channel, paired.workspace, uid, payload.command);
		return '';

	case 'manual':
		var readme = await fs.promises.readFile(README, {
			encoding: 'utf8',
		});
		readme = readme.split('\n\n');

		var usermanual = readme.findIndex(function(elem) {
			return elem.startsWith(USERMANUAL);
		});
		return readme[usermanual + 1];

	default:
		error = '*Error:* Unrecognized command: \'' + command + '\'\n';
	case 'help':
		error += 'Supported commands:'
			+ '\n>' + payload.command + ' help\n\tShow this help'
			+ '\n>' + payload.command + ' manual\n\tShow detailed user documentation'
			+ '\n>' + payload.command + ' list [channel]\n\tList bridged members of current channel (or specified [channel])'
			+ '\n>' + payload.command + ' dm <user> [- channel]\n\tDirect message specified <user> (bridged via [channel])'
			+ '\n\n_Note: In the above commands, <word> and [word] are not part of the command;'
			+ ' rather, each <word> is a required argument that you must replace,'
			+ ' and each [word] is an optional argument that you may either omit or replace._';
		return error;
	}
}

async function handle_event(event) {
	if(event.type == 'member_joined_channel') {
		handle_join(event);
		return;
	} else if(event.type == 'member_left_channel') {
		handle_leave(event);
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
		console.log('Unhandled type in event: ' + JSON.stringify(event));
		return;
	} else if(event.bot_id || (event.message && event.message.bot_id))
		return;
	if(LOGGING)
		console.log(event);

	var team = event.team;
	if(event.subtype == 'message_deleted') {
		var copy = await messages(event.deleted_ts);
		if(copy) {
			var ack = await call('chat.delete', {
				channel: copy.out_conversation,
				ts: copy.out_ts,
			}, copy.out_workspace);
			if(LOGGING)
				console.log(ack);
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
			
			var ack = await call('chat.update', message, copy.out_workspace);
			if(LOGGING)
				console.log(ack);
		}
		return;
	} else if(event.subtype && (event.subtype == 'thread_broadcast'
		|| event.subtype.endsWith('_join') || event.subtype.endsWith('_leave')
		|| event.subtype == 'file_share'))
		team = cache.team(event.channel);

	var message = {
		text: event.text,
	};
	var thread;
	if(event.thread_ts) {
		thread = await messages(event.thread_ts);
		if(thread) {
			message.thread_ts = thread.out_ts;
			if(event.subtype == 'thread_broadcast')
				message.reply_broadcast = true;
		}
	}

	var workspace = await cache.workspace(team);
	if(!workspace)
		return;

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
		}

		var error;
		if(message.thread_ts && (!paired
			|| thread.out_workspace != paired.workspace || thread.out_conversation != paired.channel)) {
			channel = cache.line(thread.out_workspace, thread.out_channel, true);
			if(channel)
				channel = channel.channel;
			else
				channel = thread.in_channel;

			var remote;
			if(!await is_member(workspace, channel, event.user))
				error = '*Error:* You can no longer DM this person because you have'
					+ ' been removed from the \'' + channel + '\' channel!';
			else if((remote = cache.line(workspace, channel).channel)
				&& !await is_member(thread.out_workspace, remote,
					cache.imer(thread.out_conversation, thread.out_workspace)))
				error = '*Error:* You can no longer DM this person because they have'
					+ ' been unbridged from the \'' + channel + '\' channel!';
			else {
				paired = {
					workspace: thread.out_workspace,
					channel: thread.out_conversation,
				};

				var meta = await call('conversations.info?channel='
					+ paired.channel, null, paired.workspace);
				select_user(event.user, workspace, channel, paired.workspace, meta.channel.user);
			}
		}

		if(!channel || !paired) {
			await call('reactions.add', {
				channel: event.channel,
				timestamp: event.ts,
				name: 'warning',
			}, workspace);
			if(!error)
				error = '*Error:* You must either reply in a thread or specify a user to direct message!\n'
					+ '_For help: click my avatar, choose an option beginning with \'/\', and hit send._';
			warning(workspace, event.channel, event.user, error);
			return;
		}
	} else {
		channel = await cache.channel(event.channel, workspace);
		paired = cache.line(workspace, channel);
		if(!channel || !paired)
			return;
	}
	message.channel = paired.channel;

	var user = await cache.user(event.user, channel, workspace);
	if(user) {
		var users = paired.channel;
		message.icon_url = user.avatar;
		message.username = user.name;
		if(event.channel_type == 'im') {
			message.username += ' - ' + cache.line(workspace, channel).channel;

			var uid = await call('conversations.info?channel='
				+ paired.channel, null, paired.workspace);
			uid = uid.channel.user;

			var name = await cache.user(uid, cache.line(workspace, channel), paired.workspace);
			name = name.name;
			users = {};
			users[name] = uid;
		}

		message.text = await process_users(workspace, channel, event.user,
			message.text, paired.workspace, users, event.channel);
	}

	var ack = await call('chat.postMessage', message, paired.workspace);
	if(LOGGING)
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

async function handle_leave(event) {
	var workspace = await cache.workspace(event.team);
	var channel = await cache.channel(event.channel, workspace);
	await cache.unuser(event.user, channel, workspace);

	var dm = cache.dm(event.user);
	if(dm && dm.in_channel == channel) {
		dm.uid = undefined;
		await clean_channel(workspace, event.user);
		warning(workspace, event.user, event.user,
			'You can no longer DM this person because you have been removed from the'
				+ ' \'' + channel + '\' channel.');
	}

	var paired;
	var dmers = cache.dmers(event.user);
	for(var dmer of dmers) {
		if(!paired)
			paired = cache.line(workspace, channel);

		var dimmer = cache.dm(dmer);
		dimmer.uid = undefined;
		await clean_channel(paired.workspace, dmer);
		warning(paired.workspace, dmer, dmer,
			'You can no longer DM this person because they have been unbridged from the'
				+ ' \'' + dimmer.in_channel + '\' channel.');
	}
}
