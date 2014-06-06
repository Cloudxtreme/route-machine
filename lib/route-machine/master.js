'use strict';

var cluster = require('cluster');
var events = require('events');
var util = require('util');
var raft = require('raft');
var Metrics = require('../../../metrics-server').metric;
var Logger = require('../../../Logger').Logger;

function Master(config) {
	if (!(this instanceof Master)) {
		return new Master(config);
	}

	this.config = config;

	this.on('exit', function() {
		//logger.stop();
	});

	this.accessLog = Logger.createLogger(raft.config.get('logs')).create('router', 'master', raft.config.get('log_session'));
	this._stats = {};
	this._statsCount = 0;
	this.metrics = {};

}

Master.prototype = new events.EventEmitter();

Master.prototype.run = function() {
	this.spawnWorkers(2);
};
Master.prototype.stats = function(stats) {
	var self = this;
	Object.keys(stats).forEach(function(virtualHost) {
		self._stats[virtualHost] = self._stats[virtualHost] || {
			bytesWritten : 0,
			bytesRead : 0,
			count : 0,
			rt : 0,
			metrics_session : stats[virtualHost].metrics_session
		};
		self._stats[virtualHost].bytesWritten += stats[virtualHost].bytesWritten;
		self._stats[virtualHost].bytesRead += stats[virtualHost].bytesRead;
		self._stats[virtualHost].count += stats[virtualHost].count;
		self._stats[virtualHost].rt += stats[virtualHost].rt;

	});

	this._statsCount++;

	if (Object.keys(cluster.workers).length == this._statsCount) {
		Object.keys(self._stats).forEach(function(vh) {
			var m;
			if (!( m = self.metrics[vh])) {
				m = self.metrics[vh] = self.buildMetrics(vh, self._stats[vh].metrics_session);
			}
			m.bytesWritten.cb(self._stats[vh].bytesWritten);
			m.bytesRead.cb(self._stats[vh].bytesRead);
			m.count.cb(self._stats[vh].count);
			m.rt.cb(self._stats[vh].rt / self._statsCount);

		});
		self._stats = {};
		this._statsCount = 0;
	}
};

Master.prototype.buildMetrics = function(virtualHost, metrics_session) {

	var options = raft.config.get('metric');

	var bytesWritten = Metrics.createMetric(options);
	var bytesRead = Metrics.createMetric(options);
	var count = Metrics.createMetric(options);
	var rt = Metrics.createMetric(options);

	bytesWritten.interval = rt.interval = bytesRead.interval = count.interval = false;
	bytesWritten.token = rt.token = bytesRead.token = count.token = metrics_session;
	bytesWritten.group = rt.group = bytesRead.group = count.group = virtualHost;

	bytesWritten.name = 'bytesWritten';
	bytesRead.name = 'bytesRead';
	count.name = 'count';
	rt.name = 'responce_time';

	bytesWritten.start();
	bytesRead.start();
	count.start();

	rt.start();

	return {
		bytesWritten : bytesWritten,
		bytesRead : bytesRead,
		count : count,
		rt : rt
	};

};

Master.prototype.spawnWorkers = function(number) {
	var self = this;
	var spawnWorker = function() {
		var worker = cluster.fork();
		worker.on('message', function(message) {
			// Gather the logs from the workers
			if (message.type === 1) {
				// normal log
				this.accessLog.log('(worker #' + message.from + ') ' + message.data);
			} else if (message.type === 2) {
				// access log
				this.accessLog(message.data);
			} else if (message.type === 'stats') {

				this.stats(message.stats);

			}
		}.bind(this));
	}.bind(this);

	// Spawn all workers
	for (var n = 0; n < number; n += 1) {
		this.accessLog.log('Spawning worker #' + n);
		spawnWorker();
	}

	// When one worker is dead, let's respawn one
	cluster.on('exit', function(worker, code, signal) {
		var m = 'Worker died (pid: ' + worker.process.pid + ', suicide: ' + (worker.suicide === undefined ? 'false' : worker.suicide.toString());
		if (worker.suicide === false) {
			if (code !== null) {
				m += ', exitcode: ' + code;
			}
			if (signal !== null) {
				m += ', signal: ' + signal;
			}
		}
		m += '). Spawning a new one.';
		self.accessLog.log(m);
		spawnWorker();
	});

	// Set an exit handler
	var onExit = function() {
		this.emit('exit');
		self.accessLog.log('Exiting, killing the workers');
		for (var id in cluster.workers) {
			var worker = cluster.workers[id];
			util.log('Killing worker #' + worker.process.pid);
			worker.destroy();
		}
		process.exit(0);
	}.bind(this);
	process.on('SIGINT', onExit);
	process.on('SIGTERM', onExit);
};

module.exports = Master;
