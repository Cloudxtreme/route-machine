'use strict';

/*
 * This module handles all IO called on the cache (currently Redis)
 */

var url = require('url');
var raft = require('raft');
var Logger = require('../../../Logger').Logger;

function BackEnd(options, logger) {

	for (var key in options) {
		this[key] = options[key]
	}

	this.logger = logger.create(options.name, 'router', options.log_session);

	this.died = false;
	this._stats = {
		bytesWritten : 0,
		bytesRead : 0,
		count : 0,
		rt : []
	};

}

BackEnd.prototype.markDied = function() {

};

BackEnd.prototype.target = function() {
	return {
		port : this.port,
		host : this.hostname
	};
};
BackEnd.prototype.info = function() {
	var data = {};

	data.hostname = this.hostname;
	data.port = this.port;
	data.ps_type = this.ps_type;
	data.app_id = this.app_id;
	data.instance_id = this.instance_id;
	data.log_session = this.log_session;
	data.metrics_session = this.metrics_session;

	data.index = this.index;
	data.virtualHost = this.virtualHost;
	data.name = this.name;
	return data
};

BackEnd.prototype.stats = function(req, res) {
	var self = this;

	self._stats.bytesWritten += req.connection.bytesWritten;
	self._stats.bytesRead += req.connection.bytesRead;
	self._stats.count++;
	self._stats.rt.push(res.timer.end - res.timer.start);

};

function Cache(router) {
	if (!(this instanceof Cache)) {
		return new Cache(router);
	}

	this.router = router;

	this.logger = Logger.createLogger(raft.config.get('logs'));

	var backends = this.backends = {};

	setInterval(function() {
		var stats = {};
		Object.keys(backends).forEach(function(virtualHost) {
			if (backends[virtualHost].length == 0) {
				return;
			}

			stats[virtualHost] = stats[virtualHost] || {
				bytesWritten : 0,
				bytesRead : 0,
				count : 0,
				rt : 0,
				metrics_session : backends[virtualHost][0].metrics_session
			};
			backends[virtualHost].forEach(function(backend) {
				stats[virtualHost].bytesWritten += backend._stats.bytesWritten;
				stats[virtualHost].bytesRead += backend._stats.bytesRead;
				stats[virtualHost].count += backend._stats.count;
				if (backend._stats.rt.length) {

					var sum = 0;

					backend._stats.rt.forEach(function(time) {
						sum += time;
					});
					stats[virtualHost].rt = sum / backend._stats.rt.length;

				}
				backend._stats = {
					bytesWritten : 0,
					bytesRead : 0,
					count : 0,
					rt : []
				};
			});
		});
		var message = {
			type : 'stats',
			from : process.pid,
			stats : stats
		};
		process.send(message);

	}, 1000);

	this.subscribe();

}

Cache.prototype.markDeadBackend = function(backendInfo) {

};

Cache.prototype.register = function(virtualHost, backendInfo) {

	backendInfo.virtualHost = virtualHost;
	var port = backendInfo.port;
	var hostname = backendInfo.hostname;

	var backends = this.backends[virtualHost];

	if (!backends) {
		backends = this.backends[virtualHost] = [];
	}

	for (var i = 0, j = backends.length; i < j; i++) {
		if (backends[i].port == port && backends[i].hostname == hostname) {
			return;
		}
	};
	var backend = new BackEnd(backendInfo, this.logger);

	backends.push(backend);

};
Cache.prototype.unregister = function(virtualHost, backendInfo) {

	var backends = this.backends[virtualHost] || [];
	for (var i = 0; i < backends.length; i++) {
		var d = backends[i];
		if (d['hostname'] == backendInfo.hostname && d['port'] == backendInfo.port)
			backends.splice(i, 1);
	};

	this.backends[virtualHost] = backends;

};

Cache.prototype.subscribe = function() {
	var self = this;

	raft.nats.subscribe('router.register', function(backendInfo) {

		var uris;
		if (!( uris = backendInfo['uris'])) {
			return;
		}
		uris.forEach(function(virtualHost) {
			self.register(virtualHost, backendInfo);
		});

	});
	raft.nats.subscribe('router.unregister', function(backendInfo) {
		var uris;
		if (!( uris = backendInfo['uris'])) {
			return;
		}
		uris.forEach(function(virtualHost) {
			self.unregister(virtualHost, backendInfo);
		});
	});

	raft.nats.subscribe('router.list', function(msg, reply) {
		var data = {};
		var backends = self.backends;
		Object.keys(backends).forEach(function(virtualHost) {
			data[virtualHost] = [];
			backends[virtualHost].forEach(function(backend) {
				data[virtualHost].push(backend.info());
			});
		});
		raft.nats.publish(reply, {
			uid : self.router.uid,
			hosts : data
		});
	});
};

Cache.prototype.getBackendFromHostHeader = function(host, callback) {
	if (host === undefined) {
		return callback('no host header', 400);
	}
	if (host === '__ping__') {
		return callback('ok', 200);
	}
	var index = host.indexOf(':');
	if (index > 0) {
		host = host.slice(0, index).toLowerCase();
	}

	var backends = this.backends[host];
	if (!backends) {
		return callback('frontend not found', 400);
	}

	if (!backends.length) {
		return callback('Cannot find a valid backend', 502);
	}

	var backend = backends.shift();
	backends.push(backend);
	callback(false, 0, backend);

};

module.exports = Cache;
