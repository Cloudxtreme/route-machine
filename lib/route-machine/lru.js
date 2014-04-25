(function() {'use strict';

	var LruWrapper = function() {
		var cache = {};

		this.enabled = false;

		this.get = function(k) {
			return cache[k];
		};

		this.del = function(k) {
			delete cache[k];
		};

		this.set = function(k, v) {
			return cache[k] = v;
		};
	};

	module.exports = LruWrapper;
})();
