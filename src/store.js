// dependencies
var _ = require('lodash');
var fs = require('fs-extra');
var kue = require('kue');
var path = require('path');
var zlib = require('zlib');
var uuid = require('uuid');
var async = require('async');
var redis = require('redis');
var carto = require('carto');
var mapnik = require('mapnik');
var colors = require('colors');
var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
var mongoose = require('mongoose');
var request = require('request');

// global paths
var VECTORPATH   = '/data/vector_tiles/';
var RASTERPATH   = '/data/raster_tiles/';
var GRIDPATH     = '/data/grid_tiles/';

// config
var config = require('../config/pile-config');

var pile_settings = {
	store : 'disk' // or redis
}

var redis = require('redis');
var redisStore = redis.createClient(config.redis.port, config.redis.host, {detect_buffers : true});
redisStore.auth(config.redis.auth);
redisStore.on('error', function (err) { console.error('redisStore err: ', err); });


var kueStore = redis.createClient(config.kueredis.port, config.kueredis.host);
kueStore.auth(config.kueredis.auth);
kueStore.on('error', function (err) { console.error('kueStore err: ', err); });
kueStore.flushall(function (err) {
	console.log('kueStore flushedall!', err);
});

module.exports = store = { 

	redis : redisStore,

	kue : kueStore,





	_saveVectorTile : function (tile, params, done) {
		if (pile_settings.store == 'redis') return store._saveVectorTileRedis(tile, params, done);
		if (pile_settings.store == 'disk')  return store._saveVectorTileDisk(tile, params, done);
		return done('pile_settings.store not set!');
	},
	_saveRasterTile : function (tile, params, done) {
		if (pile_settings.store == 'redis') return store._saveRasterTileRedis(tile, params, done);
		if (pile_settings.store == 'disk')  return store._saveRasterTileDisk(tile, params, done);
		return done('pile_settings.store not set!');
	},
	_readRasterTile : function (params, done) {
		if (pile_settings.store == 'redis') return store._readRasterTileRedis(params, done);
		if (pile_settings.store == 'disk')  return store._readRasterTileDisk(params, done);
		return done('pile_settings.store not set!');
	},







	_saveVectorTileRedis : function (tile, params, done) {
		// save png to redis
		var keyString = 'vector_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
		var key = new Buffer(keyString);
		redisStore.set(key, tile.getData(), done);
	},
	_saveRasterTileRedis : function (tile, params, done) {
		// save png to redis
		var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
		var key = new Buffer(keyString);
		redisStore.set(key, tile.encodeSync('png'), done);
	},
	_readRasterTileRedis : function (params, done) {
		var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
		var key = new Buffer(keyString);
		redisStore.get(key, done);
	},

	




	_saveVectorTileDisk : function (tile, params, done) {
		var keyString = 'vector_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
		var path = VECTORPATH + keyString;
		fs.outputFile(path, tile.getData(), done);
	},
	_saveRasterTileDisk : function (tile, params, done) {
		var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';
		var path = RASTERPATH + keyString;
		console.time('saving raster to disk', keyString);
		tile.encode('png', function (err, buffer) {
			console.log('tile encode err? ', err);
			fs.outputFile(path, buffer, function (err) {
				console.log('saved err?', err);
				done(null);
				console.timeEnd('saving raster to disk');
			});
		});
	},
	_readRasterTileDisk : function (params, done) {
		var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';
		var path = RASTERPATH + keyString;
		fs.readFile(path, function (err, buffer) {
			if (err) return done(null);
			done(null, buffer);
		});
	},


}