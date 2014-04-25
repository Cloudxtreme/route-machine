var cluster = require('cluster');

var master = require('../lib/route-machine/master');
var worker = require('../lib/route-machine/worker');

var config = {
	"server" : {
		"debug" : false,
		"accessLog" : "/tmp/proxy2_test_access.log",
		"port" : 1080,
		"workers" : 2,
		"maxSockets" : 200,
		"deadBackendTTL" : 30,
		"tcpTimeout" : 5,
		"retryOnError" : 2,
		"deadBackendOn500" : true,
		"httpKeepAlive" : false
	}
};

if (cluster.isMaster) {
	// Run the master
	var m = master(config);
	m.run();
	console.log('Server is running. ' + JSON.stringify(config.server));
} else {
	// Run the worker
	var w = worker(config);
	w.run();
}