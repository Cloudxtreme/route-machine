'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var http = require('http');
var url = require('url');
var https = require('https');

var raft = require('raft');

var ejs = require('ejs');
var httpProxy = require('http-proxy');
var Cache = require('./cache');
var memoryMonitor = require('./memorymonitor');
var AccessLogger = require('./accesslogger');

var Logger = require('../../../Logger').Logger;

ejs.open = '{{';
ejs.close = '}}';

var rootDir = fs.realpathSync(__dirname + '/../../');

var VERSION = require(path.join(__dirname, '..', '..', 'package.json')).version;

var logType = {
	log : 1,
	accessLog : 2
};

var logger = new AccessLogger();

var log = function(msg, type) {
	// Send the log data to the master
	var message = {};
	try {
		message = {
			type : (type === undefined) ? logType.log : type,
			from : process.pid,
			data : msg
		};
		process.send(message);
	} catch (err) {
		// Cannot write on the master channel (worker is committing a suicide)
		// (from the memorymonitor), writing the log directly.
		if (message.type === 1) {
			console.log('(worker #' + message.from + ') ' + message.data);
		}
	}
};

var debug = function(debugMode) {
	return function(msg) {
		if (debugMode !== true) {
			return;
		}
		log(msg, logType.log);
	};
};

// Ignore SIGUSR
process.on('SIGUSR1', function() {
	//
});
process.on('SIGUSR2', function() {
	//
});

function Worker(config) {
	if (!(this instanceof Worker)) {
		return new Worker(config);
	}

	this.uid = raft.common.uuid();

	this.logger = Logger.createLogger(raft.config.get('logs'));

	this.console = this.logger.create('router', 'info', raft.config.get('log_session'));

	this.monitor = memoryMonitor({
		logger : this.logger
	});
	this.config = config;

	this.cache = new Cache(this);

}

Worker.prototype.run = function() {
	this.runServer(this.config);
	raft.nats.publish('router.start', {});
	this.loadStatic();
};

Worker.prototype.runServer = function(config) {
	var self = this;
	var options = {};
	if (config.httpKeepAlive !== true) {
		// Disable the http Agent of the http-proxy library so we force
		// the proxy to close the connection after each request to the backend
		options.agent = false;
	}
	var proxy = this.proxy = httpProxy.createProxyServer(options);
	http.globalAgent.maxSockets = config.maxSockets;
	https.globalAgent.maxSockets = config.maxSockets;

	// Set proxy handlers
	proxy.on('error', this.proxyErrorHandler.bind(this));
	proxy.on('start', this.startHandler.bind(this));

	//http
	(function() {
		var httpServer;

		if (config.address) {
			var length = config.address.length;
			for (var i = 0; i < length; i++) {
				httpServer = http.createServer(self.httpRequestHandler.bind(self));
				httpServer.on('connection', self.tcpConnectionHandler.bind(self));
				httpServer.on('upgrade', self.wsRequestHandler.bind(self));
				httpServer.listen(config.port, config.address[i]);
				self.monitor.addServer(httpServer);
			}
			return;
		}
		httpServer = http.createServer(self.httpRequestHandler.bind(self));
		httpServer.on('connection', self.tcpConnectionHandler.bind(self));
		httpServer.on('upgrade', self.wsRequestHandler.bind(self));
		httpServer.listen(config.port, '::');
		self.monitor.addServer(httpServer);
	})();

};
Worker.prototype.loadStatic = function() {
	var self = this;
	fs.readFile(__dirname + '/../../static/code.html', function(err, data) {
		if (err)
			throw err;
		self.compiled = ejs.compile(data.toString(), {});
	});
};
Worker.prototype.proxyErrorHandler = function(err, req, res) {
	if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || req.error !== undefined) {
		// This backend is dead
		var instance_id = req.meta.instance_id;
		if (req.meta.index > 1) {
			this.cache.markDeadBackend(req.meta);
		}
		if (req.error) {
			err = req.error;
			// Clearing the error
			delete req.error;
		}
		this.console.log(req.headers.host + ': backend #' + instance_id + ' is dead (' + JSON.stringify(err) + ') while handling request for ' + req.url);
	} else {
		this.console.log(req.headers.host + ': backend #' + req.meta.instance_id + ' reported an error (' + JSON.stringify(err) + ') while handling request for ' + req.url);
	}
	req.retries = (req.retries === undefined) ? 0 : req.retries + 1;
	if (!res.connection || res.connection.destroyed === true) {
		// FIXME: When there is a TCP timeout, the socket of the Response
		// object is closed. Not possible to return a result after a retry.
		// BugID:5654
		this.console.log(req.headers.host + ': Response socket already closed, aborting.');
		try {
			return this.errorMessage(res, 'Cannot retry on error', 502);
		} catch (err) {
			// Even if the client socket is closed, we return an error
			// to force calling a res.end(). We do it safely in case there
			// is an error
			this.console.log(req.headers.host + ': Cannot end the request properly (' + err + ').');
		}
	}
	if (req.retries >= this.config.retryOnError) {
		if (this.config.retryOnError) {
			this.console.log(req.headers.host + ': Retry limit reached (' + this.config.retryOnError + '), aborting.');
			return this.errorMessage(res, 'Reached max retries limit', 502);
		}
		return this.errorMessage(res, 'Retry on error is disabled', 502);
	}
	req.emit('retry');
};

Worker.prototype.startHandler = function(req, res) {
	var remoteAddr = this.getRemoteAddress(req);

	req.connection.setKeepAlive(false);
	// TCP timeout to 30 sec
	req.connection.setTimeout(this.config.tcpTimeout * 1000);
	// Make sure the listener won't be set again on retry
	if (req.connection.listeners('timeout').length < 2) {
		req.connection.once('timeout', function() {
			req.error = 'TCP timeout';
		});
	}

	// Set forwarded headers
	if (remoteAddr === null) {
		return this.errorMessage(res, 'Cannot read the remote address.');
	}
	if (remoteAddr.slice(0, 2) !== '::') {
		remoteAddr = '::ffff:' + remoteAddr;
	}
	// Play nicely when behind other proxies
	if (req.headers['x-forwarded-for'] === undefined) {
		req.headers['x-forwarded-for'] = remoteAddr;
	}
	if (req.headers['x-real-ip'] === undefined) {
		req.headers['x-real-ip'] = remoteAddr;
	}
	if (req.headers['x-forwarded-protocol'] === undefined) {
		req.headers['x-forwarded-protocol'] = req.connection.pair ? 'https' : 'http';
	}
	if (req.headers['x-forwarded-proto'] === undefined) {
		req.headers['x-forwarded-proto'] = req.connection.pair ? 'https' : 'http';
	}
	if (req.headers['x-forwarded-port'] === undefined) {
		// FIXME: replace by the real port instead of hardcoding it
		req.headers['x-forwarded-port'] = req.connection.pair ? '443' : '80';
	}
};

Worker.prototype.getRemoteAddress = function(req) {
	if (req.connection === undefined) {
		return null;
	}
	if (req.connection.remoteAddress) {
		return req.connection.remoteAddress;
	}
	if (req.connection.socket && req.connection.socket.remoteAddress) {
		return req.connection.socket.remoteAddress;
	}
	return null;
};

Worker.prototype.errorMessage = function(res, message, code) {
	var self = this;
	// Flag the Response to know that it's an internal error message

	res.errorMessage = true;
	if (message === undefined) {
		message = '';
	}
	code = isNaN(code) ? 400 : parseInt(code, 10);

	this.serveText(message, code, res);
};

Worker.prototype.serveFile = function(filePath, code, res) {
	var stream = fs.createReadStream(filePath);
	var headers = {
		'content-type' : 'text/html',
		'cache-control' : 'no-cache',
		'pragma' : 'no-cache',
		'expires' : '-1'
	};
	if (res.debug === true) {
		headers['x-debug-error'] = message;
		headers['x-debug-version-hipache'] = VERSION;
	}
	res.writeHead(code, headers);
	stream.on('data', function(data) {
		res.write(data);
	});
	stream.on('error', function() {
		res.end();
	});
	stream.on('end', function() {
		res.end();
	});
};

Worker.prototype.staticPath = function(name) {
	return rootDir + '/static/error_' + name + '.html';
};

Worker.prototype.serveText = function(message, code, res) {

	var text = this.compiled({
		text : message,
		code : code
	}, {});

	var headers = {
		'content-length' : text.length,
		'content-type' : 'text/html; charset=utf-8',
		'cache-control' : 'no-cache',
		'pragma' : 'no-cache',
		'expires' : '-1'
	};
	if (res.debug === true) {
		headers['x-debug-error'] = message;
		headers['x-debug-version-hipache'] = VERSION;
	}

	res.writeHead(code, headers);

	res.end(text);
};

Worker.prototype.httpRequestHandler = function(req, res) {

	var self = this;

	res.timer = {
		start : Date.now()
	};

	// Enable debug?
	res.debug = (req.headers['x-debug'] !== undefined);
	// Patch the res.writeHead to detect backend HTTP errors and handle
	// debug headers
	var resWriteHead = res.writeHead;
	res.writeHead = function(statusCode) {
		if (res.sentHeaders === true) {
			// In case of errors when streaming the backend response,
			// we can resend the headers when raising an error.
			return;
		}
		res.sentHeaders = true;
		res.timer.end = Date.now();
		if (req.meta === undefined) {
			return resWriteHead.apply(res, arguments);
		}
		var markDeadBackend = function() {
			var instance_id = req.meta.instance_id;
			if (req.meta.index > 1) {
				self.cache.markDeadBackend(req.meta);
			}
			self.console.log(req.headers.host + ': backend #' + instance_id + ' is dead (HTTP error code ' + statusCode + ') while handling request for ' + req.url);
		};
		// If the HTTP status code is 5xx, let's mark the backend as dead
		// We consider the 500 as critical errors only if the setting "deadBackendOn500" is enbaled
		// and only if the active health checks are running.
		var startErrorCode = (self.config.deadBackendOn500 === true && self.cache.passiveCheck === false) ? 500 : 501;
		if ((statusCode >= startErrorCode && statusCode < 600) && res.errorMessage !== true) {
			if (statusCode === 503) {
				var headers = arguments[arguments.length - 1];
				if ( typeof headers === 'object') {
					// Let's lookup the headers to find a "Retry-After"
					// In this case, this is a legit maintenance mode
					if (headers['retry-after'] === undefined) {
						markDeadBackend();
					}
				}
			} else {
				// For all other cases, mark the backend as dead
				markDeadBackend();
			}
		}
		// If debug is enabled, let's inject the debug headers
		if (res.debug === true) {
			res.setHeader('x-debug-version-hipache', VERSION);
			res.setHeader('x-debug-backend-url', req.meta.backendUrl);
			res.setHeader('x-debug-backend-id', req.meta.instance_id);
			res.setHeader('x-debug-vhost', req.meta.virtualHost);
			res.setHeader('x-debug-frontend-key', req.meta.frontend);
			res.setHeader('x-debug-time-total', (res.timer.end - res.timer.start));
			res.setHeader('x-debug-time-backend', (res.timer.end - res.timer.startBackend));
		}
		res.setHeader('connection', 'close');
		return resWriteHead.apply(res, arguments);
	};
	// Patch res.end to log the response stats
	var resEnd = res.end;
	res.end = function() {
		resEnd.apply(res, arguments);
		// Number of bytes written on the client socket
		var socketBytesWritten = req.connection ? req.connection.bytesWritten : 0;
		if (req.meta === undefined || req.headers['x-real-ip'] === undefined) {
			return;
			// Nothing to log
		}
		res.timer.end = Date.now();
		// Log the request

		logger.log({
			remoteAddr : req.headers['x-real-ip'],
			currentTime : res.timer.start,
			totalTimeSpent : (res.timer.end - res.timer.start),
			backendTimeSpent : (res.timer.end - res.timer.startBackend),
			method : req.method,
			url : req.url,
			httpVersion : req.httpVersion,
			statusCode : res.statusCode,
			socketBytesWritten : socketBytesWritten,
			referer : req.headers.referer,
			userAgent : req.headers['user-agent'],
			virtualHost : req.meta.virtualHost
		}, req.meta.logger);

		req.meta.stats(req, res);
	};
	if (this.config.retryOnError) {
		req.on('retry', function() {
			self.console.log('Retrying on ' + req.headers.host);
			self.proxyRequest(req, res);
		});
	}

	this.proxyRequest(req, res);
};

Worker.prototype.proxyRequest = function(req, res) {

	var self = this;

	this.cache.getBackendFromHostHeader(req.headers.host, function(err, code, backend) {
		if (err) {
			return self.errorMessage(res, err, code);
		}

		req.meta = backend;

		// Proxy the request to the backend
		res.timer.startBackend = Date.now();
		
		self.proxy.emit('start', req, res);

		self.proxy.web(req, res, {
			target : backend.target(),
			xfwd : false
		});
	});
};

Worker.prototype.wsRequestHandler = function(req, socket, head) {
	var self = this;
	this.cache.getBackendFromHostHeader(req.headers.host, function(err, code, backend) {
		if (err) {
			self.console.log('proxyWebSocketRequest: ' + err);
			return;
		}

		// Proxy the WebSocket request to the backend
		self.proxy.ws(req, socket, head, {
			target : backend.target()
		});
	});
};

Worker.prototype.tcpConnectionHandler = function(connection) {
	var self = this;
	var start = Date.now();

	connection.setKeepAlive(false);
	connection.setTimeout(this.config.tcpTimeout * 1000);

	connection.on('error', function(error) {
		self.console.log('TCP error from ' + self.getSocketInfo(connection, start) + '; Error: ' + JSON.stringify(error));
	});
	connection.on('timeout', function() {
		self.console.log('TCP timeout from ' + self.getSocketInfo(connection, start));
		connection.destroy();
	});
};

Worker.prototype.getSocketInfo = function(connection, start) {
	var remoteAddress = connection.remoteAddress;
	var remotePort = connection.remotePort;
	return JSON.stringify({
		remoteAddress : remoteAddress,
		remotePort : remotePort,
		bytesWritten : connection.bytesWritten,
		bytesRead : connection.bytesRead,
		elapsed : (Date.now() - start) / 1000
	});
};

module.exports = Worker;
