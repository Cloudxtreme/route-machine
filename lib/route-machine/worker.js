'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var http = require('http');
var url = require('url');
var https = require('https');
var httpProxy = require('http-proxy');
//var cache = require('./cache');
var memoryMonitor = require('./memorymonitor');
var AccessLogger = require('./accesslogger');
var rootDir = fs.realpathSync(__dirname + '/../../');

var hipacheVersion = require(path.join(__dirname, '..', '..', 'package.json')).version;

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
	var self = this;
	debug = debug(config.server.debug);
	this.reqPerSec = 0;
	this.monitor = memoryMonitor({
		logHandler : log
	});
	this.config = config.server;

	this.cache = {
		markDeadBackend : function(data) {
			//console.log(data)
		},
		getBackendFromHostHeader : function(host, callback) {
			//console.log(arguments)
			var backend = url.parse('http://localhost/');
			backend.id = 1;
			// Store the backend index
			backend.frontend = 'localhost';
			// Store the associated frontend
			backend.virtualHost = 'localhost';
			// Store the associated vhost
			backend.len = 1;
			backend.hostname = 'localhost';
			if (!backend.hostname) {
				return callback('backend is invalid', 502);
			}
			backend.port = 28778;
			callback(false, 0, backend);
		}
	};
	setInterval(function() {
		log(self.reqPerSec/60)
		self.reqPerSec = 0
	}, 60 * 1000);

}

Worker.prototype.run = function() {
	this.runServer(this.config);
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

Worker.prototype.proxyErrorHandler = function(err, req, res) {
	if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || req.error !== undefined) {
		// This backend is dead
		var backendId = req.meta.backendId;
		if (req.meta.backendLen > 1) {
			this.cache.markDeadBackend(req.meta);
		}
		if (req.error) {
			err = req.error;
			// Clearing the error
			delete req.error;
		}
		log(req.headers.host + ': backend #' + backendId + ' is dead (' + JSON.stringify(err) + ') while handling request for ' + req.url);
	} else {
		log(req.headers.host + ': backend #' + req.meta.backendId + ' reported an error (' + JSON.stringify(err) + ') while handling request for ' + req.url);
	}
	req.retries = (req.retries === undefined) ? 0 : req.retries + 1;
	if (!res.connection || res.connection.destroyed === true) {
		// FIXME: When there is a TCP timeout, the socket of the Response
		// object is closed. Not possible to return a result after a retry.
		// BugID:5654
		log(req.headers.host + ': Response socket already closed, aborting.');
		try {
			return this.errorMessage(res, 'Cannot retry on error', 502);
		} catch (err) {
			// Even if the client socket is closed, we return an error
			// to force calling a res.end(). We do it safely in case there
			// is an error
			log(req.headers.host + ': Cannot end the request properly (' + err + ').');
		}
	}
	if (req.retries >= this.config.retryOnError) {
		if (this.config.retryOnError) {
			log(req.headers.host + ': Retry limit reached (' + this.config.retryOnError + '), aborting.');
			return this.errorMessage(res, 'Reached max retries limit', 502);
		}
		return this.errorMessage(res, 'Retry on error is disabled', 502);
	}
	req.emit('retry');
};

Worker.prototype.startHandler = function(req, res) {
	var remoteAddr = this.getRemoteAddress(req);

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
	var self = this
	// Flag the Response to know that it's an internal error message
	res.errorMessage = true;
	if (message === undefined) {
		message = '';
	}
	code = isNaN(code) ? 400 : parseInt(code, 10);

	if (code === 200) {
		// If code is 200, let's just serve the text message since
		// it's not an error...
		return this.serveText(message, code, res);
	}

	var errorPage = this.staticPath(code);
	fs.exists(errorPage, function(exists) {
		if (exists === true) {
			return self.serveFile(errorPage, code, res);
		}
		errorPage = self.staticPath('default');
		fs.exists(errorPage, function(exists) {
			if (exists === true) {
				return self.serveFile(errorPage, code, res);
			}
			return self.serveText(message, code, res);
		});
	});
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
		headers['x-debug-version-hipache'] = hipacheVersion;
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
	var headers = {
		'content-length' : message.length,
		'content-type' : 'text/plain',
		'cache-control' : 'no-cache',
		'pragma' : 'no-cache',
		'expires' : '-1'
	};
	if (res.debug === true) {
		headers['x-debug-error'] = message;
		headers['x-debug-version-hipache'] = hipacheVersion;
	}
	res.writeHead(code, headers);
	res.write(message);
	res.end();
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
			var backendId = req.meta.backendId;
			if (req.meta.backendLen > 1) {
				self.cache.markDeadBackend(req.meta);
			}
			log(req.headers.host + ': backend #' + backendId + ' is dead (HTTP error code ' + statusCode + ') while handling request for ' + req.url);
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
			res.setHeader('x-debug-version-hipache', hipacheVersion);
			res.setHeader('x-debug-backend-url', req.meta.backendUrl);
			res.setHeader('x-debug-backend-id', req.meta.backendId);
			res.setHeader('x-debug-vhost', req.meta.virtualHost);
			res.setHeader('x-debug-frontend-key', req.meta.frontend);
			res.setHeader('x-debug-time-total', (res.timer.end - res.timer.start));
			res.setHeader('x-debug-time-backend', (res.timer.end - res.timer.startBackend));
		}
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

		self.reqPerSec++;
		return;
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
		}, logType.accessLog);
	};
	if (this.config.retryOnError) {
		req.on('retry', function() {
			log('Retrying on ' + req.headers.host);
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
		req.meta = {
			backendId : backend.id,
			backendLen : backend.len,
			frontend : backend.frontend,
			virtualHost : backend.virtualHost,
			backendUrl : backend.href
		};
		// Proxy the request to the backend
		res.timer.startBackend = Date.now();
		self.proxy.emit('start', req, res);
		self.proxy.web(req, res, {
			target : {
				host : backend.hostname,
				port : backend.port
			},
			xfwd : false
		});
	});
};

Worker.prototype.wsRequestHandler = function(req, socket, head) {
	var self = this;
	this.cache.getBackendFromHostHeader(req.headers.host, function(err, code, backend) {
		if (err) {
			log('proxyWebSocketRequest: ' + err);
			return;
		}
		// Proxy the WebSocket request to the backend
		self.proxy.ws(req, socket, head, {
			target : {
				host : backend.hostname,
				port : backend.port
			}
		});
	});
};

Worker.prototype.tcpConnectionHandler = function(connection) {
	var self = this;
	var start = Date.now();

	connection.setKeepAlive(false);
	connection.setTimeout(this.config.tcpTimeout * 1000);
	connection.on('error', function(error) {
		log('TCP error from ' + self.getSocketInfo(connection, start) + '; Error: ' + JSON.stringify(error));
	});
	connection.on('timeout', function() {
		log('TCP timeout from ' + self.getSocketInfo(connection, start));
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

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {
};

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {
};

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {
};

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {

};

Worker.prototype._ = function() {
};

module.exports = Worker;
