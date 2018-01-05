/* ------------------------------------------------------------------
* node-dns-sd - dns-sd.js
*
* Copyright (c) 2018, Futomi Hatano, All rights reserved.
* Released under the MIT license
* Date: 2018-01-05
* ---------------------------------------------------------------- */
'use strict';
const mDgram = require('dgram');
const mOs = require('os');
const mDnsSdParser = require('./dns-sd-parser.js');
const mDnsSdComposer = require('./dns-sd-composer.js');

/* ------------------------------------------------------------------
* Constructor: DnsSd()
* ---------------------------------------------------------------- */
const DnsSd = function() {
	// Public
	this.ondata = () => {};

	// Private
	this._MULTICAST_ADDR = '224.0.0.251';
	this._UDP_PORT = 5353;
	this._DISCOVERY_WAIT_DEFAULT = 3; // sec

	this._udp = null; 
	this._source_address = '';
	this._response_packets = {};
	this._is_discovering = false;
	this._is_monitoring = false;
	this._is_listening = false;
};

/* ------------------------------------------------------------------
* Method: discover([params])
* - params:
*   - name | String or Array | Required | Servcie name.(e.g., "_googlecast._tcp.local")
*   - wait | Integer         | Optional | Duration of monitoring. The default value is 3 (sec).
* ---------------------------------------------------------------- */
DnsSd.prototype.discover = function(params) {
	let promise = new Promise((resolve, reject) => {
		if(this._is_discovering === true) {
			reject(new Error('The discovery process is running.'));
			return;
		}
		// Check the parameters
		let res = this._checkDiscoveryParameters(params);
		if(res['error']) {
			reject(res['error']);
			return;
		}
		let device_list = [];
		this._startListening().then(() => {
			return this._startDiscovery(res['params']);
		}).then(() => {
			for(let addr in this._response_packets) {
				let packet = this._response_packets[addr];
				if(this._isTargettedDevice(packet, params['name'])) {
					let device = this._createDeviceObject(packet);
					device_list.push(device);
				}
			}
			this._stopDiscovery().then(() => {
				resolve(device_list);
			});
		}).catch((error) => {
			this._stopDiscovery().then(() => {
				reject(error);
			});
		});
	});
	return promise;
};

DnsSd.prototype._createDeviceObject = function(packet) {
	let o = {};

	let trecs = {};
	['answers', 'authorities', 'additionals'].forEach((k) => {
		packet[k].forEach((r) => {
			let type = r['type'];
			if(!trecs[type]) {
				trecs[type] = [];
			}
			trecs[type].push(r);
		});
	});

	o['address'] = null;
	if(trecs['A']) {
		o['address'] = trecs['A'][0]['rdata'];
	}
	if(!o['address']) {
		o['address'] = packet['address'];
	}

	o['fqdn'] = null;
	let hostname = null;
	if(trecs['PTR']) {
		let rec = trecs['PTR'][0];
		o['fqdn'] = rec['rdata'];
	}

	o['modelName'] = null;
	o['familyName'] = null;
	if(trecs['TXT'] && trecs['TXT'][0] && trecs['TXT'][0]['rdata']) {
		let r = trecs['TXT'][0];
		let d = r['rdata'] || {};
		let name = r['name'] || '';
		if(/Apple TV/.test(name)) {
			o['modelName'] = 'Apple TV';
			if(trecs['TXT']) {
				for(let i=0; i<trecs['TXT'].length; i++) {
					let r = trecs['TXT'][i];
					if((/_device-info/).test(r['name']) && r['rdata'] && r['rdata']['model']) {
						o['modelName'] = 'Apple TV ' + r['rdata']['model'];
						break;
					}
				}
			}
		} else if(/_googlecast/.test(name)) {
			o['modelName'] = d['md'] || null;
			o['familyName'] = d['fn'] || null;
		} else if(/Philips hue/.test(name)) {
			o['modelName'] = 'Philips hue';
			if(d['md']) {
				o['modelName'] += ' ' +  d['md'];
			}
		} else if(/Canon/.test(name)) {
			o['modelName'] = d['ty'] || null;
		}
	}
	if(!o['modelName']) {
		if(trecs['A'] && trecs['A'][0]) {
			let r = trecs['A'][0];
			let name = r['name'];
			if(/Apple\-TV/.test(name)) {
				o['modelName'] = 'Apple TV';
			} else if(/iPad/.test(name)) {
				o['modelName'] = 'iPad';
			}
		}
	}

	if(!o['modelName']) {
		if(o['fqdn']) {
			let hostname = (o['fqdn'].split('.')).shift();
			if(hostname && / /.test(hostname)) {
				o['modelName'] = hostname;
			}
		}
	}

	o['service'] = null;
	if(trecs['SRV']) {
		let rec = trecs['SRV'][0];
		let name_parts = rec['name'].split('.');
		name_parts.reverse();
		o['service'] = {
			port: rec['rdata']['port'],
			protocol: name_parts[1].replace(/^_/, ''),
			type: name_parts[2].replace(/^_/, '')
		};
	}

	o['packet'] = packet;
	return o;
};

DnsSd.prototype._isTargettedDevice = function(packet, name_list) {
	let hit = false;
	packet['answers'].forEach((ans) => {
		let name = ans['name'];
		if(name && name_list.indexOf(name) >= 0) {
			hit = true;
		}
	});
	return hit;
};

DnsSd.prototype._checkDiscoveryParameters = function(params) {
	let p = {};
	if(params) {
		if(typeof(params) !== 'object') {
			return {error: new Error('The argument `params` is invalid.')};
		}
	} else {
		return {error: new Error('The argument `params` is required.')};
	}
	if('name' in params) {
		let v = params['name'];
		if(typeof(v) === 'string') {
			if(v === '') {
				return {error: new Error('The `name` must be an non-empty string.')};
			}
			p['name'] = [v];
		} else if(Array.isArray(v)) {
			if(v.length === 0) {
				return {error: new Error('The `name` must be a non-empty array.')};
			} else if(v.length > 255) {
				return {error: new Error('The `name` can include up to 255 elements.')};
			}
			let err = null;
			let list = [];
			for(let i=0; i<v.length; i++) {
				if(typeof(v[i]) === 'string' && v[i] !== '') {
					list.push(v[i]);
				} else {
					err = new Error('The `name` must be an Array object including non-empty strings.');
					break;
				}
			}
			if(err) {
				return {error: err};
			}
			p['name'] = list;
		} else {
			return {error: new Error('The `name` must be a string or an Array object.')};
		}
	} else {
		return {error: new Error('The `name` is required.')};
	}
	if('wait' in params) {
		let v = params['wait'];
		if(typeof(v) !== 'number' || v <= 0 || v % 1 !== 0) {
			return {error: new Error('The `wait` is invalid.')};
		}
		p['wait'] = v;
	}
	return {params: p};
};

DnsSd.prototype._startDiscovery = function(params) {
	let promise = new Promise((resolve, reject) => {
		this._response_packets = {};
		this._is_discovering = true;
		let wait = (params && params['wait']) ? params['wait'] : this._DISCOVERY_WAIT_DEFAULT;
		// Create a request packet
		let buf = mDnsSdComposer.compose({
			name    : params['name']
		});

		// Timer
		let send_timer = null;
		let timer = setTimeout(() => {
			if(send_timer) {
				clearTimeout(send_timer);
			}
			resolve();
		}, wait * 1000);

		// Send a packet
		let send_num = 0;
		let sendQueryPacket = () => {
			this._udp.send(buf, 0, buf.length, this._UDP_PORT, this._MULTICAST_ADDR, (error, bytes) => {
				if(error) {
					if(timer) {
						clearTimeout(timer);
						timer = null;
					}
					this._is_discovering = false;
					reject(error);
				} else {
					send_num ++;
					if(send_num < 3) {
						send_timer = setTimeout(() => {
							sendQueryPacket();
						}, 1000);
					} else {
						send_timer = null;
					}
				}
			});
		};
		sendQueryPacket();
	});
	return promise;
};

DnsSd.prototype._stopDiscovery = function() {
	let promise = new Promise((resolve, reject) => {
		this._response_packets = {};
		this._is_discovering = false;
		this._stopListening().then(() => {
			resolve();
		}).catch((error) => {
			resolve();
		});
	});
	return promise;
};

/* ------------------------------------------------------------------
* Method: startMonitoring()
* ---------------------------------------------------------------- */
DnsSd.prototype.startMonitoring = function() {
	let promise = new Promise((resolve, reject) => {
		if(this._is_monitoring === true) {
			resolve();
			return;
		}
		this._startListening().then(() => {
			this._is_monitoring = true;
			resolve();
		}).catch((error) => {
			this._is_monitoring = false;
			this._stopListening().then(() => {
				reject(error);
			});
		});
	});
	return promise;
};

/* ------------------------------------------------------------------
* Method: stopMonitoring()
* ---------------------------------------------------------------- */
DnsSd.prototype.stopMonitoring = function() {
	let promise = new Promise((resolve, reject) => {
		this._is_monitoring = false;
		this._stopListening().then(() => {
			resolve();
		}).catch((error) => {
			resolve();
		});
	});
	return promise;
};

DnsSd.prototype._startListening = function() {
	let promise = new Promise((resolve, reject) => {
		if(this._is_listening) {
			resolve();
			return;
		}
		// Get the source IP address
		this._source_address = this._getSourceIpAddress();
		// Set up a UDP tranceiver
		this._udp = mDgram.createSocket({
			type: 'udp4',
			reuseAddr: true
		});
		this._udp.once('error', (error) => {
			reject(error);
			return;
		});
		this._udp.once('listening', () => {
			this._udp.addMembership(this._MULTICAST_ADDR, this._source_address);
			this._is_listening = true;
			resolve();
			return;
		});
		this._udp.on('message', (buf, rinfo) => {
			this._receivePacket(buf, rinfo);
		});
		this._udp.bind({port: this._UDP_PORT}, () => {
			this._udp.removeAllListeners('error');
		});
	});
	return promise;
};

DnsSd.prototype._stopListening = function() {
	let promise = new Promise((resolve, reject) => {
		this._source_address = '';
		if(this._is_discovering || this._is_monitoring) {
			resolve();
		} else {
			let cleanObj = () => {
				if(this._udp) {
					this._udp.unref();
					this._udp = null; 
				}
				this._is_listening = false;
				resolve();
			};
			if(this._udp) {
				this._udp.close(() => {
					cleanObj();
				}).catch(() => {
					cleanObj();
				});
			} else {
				cleanObj();
			}
		}
	});
	return promise;
};

DnsSd.prototype._getSourceIpAddress = function() {
	let netifs = mOs.networkInterfaces();
	let mask_bit_num_max = 0;
	let source_address = null;
	for(let dev in netifs) {
		netifs[dev].forEach((info) => {
			if(info.family === 'IPv4' && info.internal === false) {
				let addr = this._parseIpAddrV4(info.address);
				let mask = this._parseIpAddrV4(info.netmask);
				if(addr && mask) {
					let addr_buf = Buffer.from([addr[0], addr[1], addr[2], addr[3]]);
					let addr_n = addr_buf.readUInt32BE(0);
					let mask_buf = Buffer.from([mask[0], mask[1], mask[2], mask[3]]);
					let mask_n = mask_buf.readUInt32BE(0);
					mask_buf = Buffer.alloc(4);
					mask_buf.writeUInt32BE(mask_n);
					let mask_bit_num = 0;
					for(let i=31; i>=0; i--) {
						if(((mask_n >> i) & 0b1) >>> 0) {
							mask_bit_num ++;
						} else {
							break;
						}
					}
					if(mask_bit_num > mask_bit_num_max) {
						source_address = [addr[0], addr[1], addr[2], addr[3]].join('.');
						mask_bit_num_max = mask_bit_num;
					}
				}
			}
		});
	}
	return source_address;
};

DnsSd.prototype._parseIpAddrV4 = function(address) {
	if(typeof(address) !== 'string') {
		return null;
	}
	let m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})($|\/\d{1,2}$)/);
	if(!m) {
		return null;
	}
	let a1 = parseInt(m[1], 10);
	let a2 = parseInt(m[2], 10);
	let a3 = parseInt(m[3], 10);
	let a4 = parseInt(m[4], 10);
	let mb = m[5];
	if(mb) {
		mb = parseInt(mb.replace('/', ''), 10);
	} else {
		mb = 0;
	}
	if(a1 < 256 && a2 < 256 && a3 < 256 && a4 < 256 && mb <= 32) {
		return [a1, a2, a3, a4, mb];
	} else {
		return null;
	}
};

DnsSd.prototype._receivePacket = function(buf, rinfo) {
	let p = mDnsSdParser.parse(buf);
	if(!p) {
		return;
	}
	p['address'] = rinfo.address;
	if(this._is_discovering) {
		if(this._isAnswerPacket(p, rinfo.address)) {
			this._response_packets[rinfo.address] = p;
		}
	}
	if(this._is_monitoring) {
		if(typeof(this.ondata) === 'function') {
			this.ondata(p);
		}
	}
};

DnsSd.prototype._isAnswerPacket = function(p, address) {
	if(address === this._source_address) {
		return false;
	}
	if(!(p['header']['qr'] === 1 && p['header']['op'] === 0)) { 
		return false;
	}
	return true;
};

module.exports = new DnsSd();