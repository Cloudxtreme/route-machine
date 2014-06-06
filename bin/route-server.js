var cluster = require('cluster');

var raft = require('raft');

var master = require('../lib/route-machine/master');
var worker = require('../lib/route-machine/worker');

raft.once('start', function() {

	if (cluster.isMaster) {
		// Run the master
		var m = master(raft.config.get('router:server'));
		m.run();
		console.log('Server is running. ' + JSON.stringify(raft.config.get('router:server')));
	} else {
		// Run the worker
		var w = worker(raft.config.get('router:server'));
		w.run();
	}
});

raft.start(process.argv[2]); 