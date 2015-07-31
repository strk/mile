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
var exec = require('child_process').exec;

// modules
var server = require('./server');
var config = require('../config/pile-config');
var store  = require('./store');

// mercator
var mercator = require('./sphericalmercator');

// register mapnik plugions
mapnik.register_default_fonts();
mapnik.register_default_input_plugins();

// database schemas
var Project 	 = require('../models/project');
var Clientel 	 = require('../models/client');	
var User  	 = require('../models/user');
var File 	 = require('../models/file');
var Layer 	 = require('../models/layer');
var Hash 	 = require('../models/hash');
var Role 	 = require('../models/role');
var Group 	 = require('../models/group');

// connect to our database
mongoose.connect(config.mongo.url); 

// global paths
var VECTORPATH   = '/data/vector_tiles/';
var RASTERPATH   = '/data/raster_tiles/';
var GRIDPATH     = '/data/grid_tiles/';

// mute console in production mode
if (process.argv[2] == 'production') {
	var nullFn = function () {};
	console.log = nullFn;
	console.time = nullFn;
	console.timeEnd = nullFn;
}


// #########################################
// ### Vector, raster, utfgrid handling  ###
// #########################################
// vector/raster/utfgrid handling
module.exports = pile = { 

	headers : {
		png : 'image/png',
		pbf : 'application/x-protobuf',
		grid : 'application/json'
	},


	// this layer is only a postgis layer. a Wu Layer Model must be created by client after receiving this postgis layer
	createLayer : function (req, res) {

		var options 	= req.body,
		    file_id 	= options.file_id,
		    sql 	= options.sql,
		    cartocss 	= options.cartocss,
		    cartocss_version = options.cartocss_version,
		    geom_column = options.geom_column,
		    geom_type 	= options.geom_type,
		    raster_band = options.raster_band,
		    srid 	= options.srid,
		    affected_tables = options.affected_tables,
		    interactivity = options.interactivity,
		    attributes 	= options.attributes,
		    access_token = req.body.access_token;

		// verify query
		if (!file_id) 	return pile.error.missingInformation(res, 'Please provide a file_id.')
		if (!sql) 	return pile.error.missingInformation(res, 'Please provide a SQL statement.')
		if (!cartocss) 	return pile.error.missingInformation(res, 'Please provide CartoCSS.')

		var ops = [];

		ops.push(function (callback) {

			// get upload status object from wu
			pile.request.get('/api/import/status', { 	// todo: write more pluggable
				file_id : file_id, 
				access_token : access_token
			}, callback);

		});

		ops.push(function (upload_status, callback) {
			if (!upload_status) return callback('No such upload_status.');

			var upload_status = JSON.parse(upload_status);

			// check that done importing to postgis
			if (!upload_status.upload_success) return callback('The data was not uploaded correctly. Please check your data and error messages, and try again.')

			// todo: errors

			// check that done importing to postgis
			if (!upload_status.processing_success) return callback('The data is not done processing yet. Please try again in a little while.')

			// all good
			callback(null, upload_status);
		});

		ops.push(function (options, callback) {

			// inject table name into sql
			var done_sql = sql.replace('table', options.table_name);

			// create layer object
			var layerUuid = 'layer_id-' + uuid.v4();
			var layer = { 	

				layerUuid : layerUuid,
				options : {			
					
					// required
					sql : done_sql,
					cartocss : cartocss,
					file_id : file_id, 	
					database_name : options.database_name, 
					table_name : options.table_name, 
					metadata : options.metadata,
					layer_id : layerUuid,
					wicked : 'thing',

					// optional				// defaults
					cartocss_version : cartocss_version 	|| '2.0.1',
					geom_column : geom_column 		|| 'geom',
					geom_type : geom_type 			|| 'geometry',
					raster_band : raster_band 		|| 0,
					srid : srid 				|| 3857,
				}
			}

			callback(null, layer);

		});


		// get extent of file (todo: put in file object)
		ops.push(function (layer, callback) {

			var GET_EXTENT_SCRIPT_PATH = 'src/get_st_extent.sh';

			// st_extent script 
			var command = [
				GET_EXTENT_SCRIPT_PATH, 	// script
				layer.options.database_name, 	// database name
				layer.options.table_name,	// table name
			].join(' ');


			// create database in postgis
			exec(command, {maxBuffer: 1024 * 50000}, function (err, stdout, stdin) {

				// parse stdout
				var extent = stdout.split('(')[1].split(')')[0];

				// set extent
				layer.options.extent = extent;

				// callback
				callback(null, layer);
			});
		});


		// save layer to store.redis
		ops.push(function (layer, callback) {

			// save layer to store.redis
			store.redis.set(layer.layerUuid, JSON.stringify(layer), function (err) {
				if (err) console.log('resdiStore.set layer err: ', err);
				callback(err, layer);
			});
		});


		async.waterfall(ops, function (err, layerObject) {
			if (err) return res.json({error : err});

			console.log('>>>>>>>>>>>>>>>>>> Created layer ', layerObject);
			
			// return layer to client
			res.json(layerObject);
		});


	},


	getLayer : function (req, res) {

		// get layerUuid
		var layerUuid = req.body.layerUuid || req.query.layerUuid;
		if (!layerUuid) return pile.error.missingInformation(res, 'Please provide layerUuid.');

		// retrieve layer and return it to client
		store.redis.get(layerUuid, function (err, layer) {
			res.end(layer);
		});
	},

	

	getTile : function (req, res) {

		// parse url into layerUuid, zxy, type
		var ops = [],
		    // https://dev.systemapic.com/tiles/layerUuid/z/x/y.png || .pbf
		    parsed = req._parsedUrl.pathname.split('/'), 
		    params = {
			layerUuid : parsed[2],
			z : parseInt(parsed[3]),
			x : parseInt(parsed[4]),
			y : parseInt(parsed[5].split('.')[0]),
			type : parsed[5].split('.')[1],
		    };

		var map,
		    layer,
		    postgis,
		    bbox;
		var type = params.type;
		var ops = [];

		// add access token to params
		params.access_token = req.query.access_token || req.body.access_token;

		console.log('getTile ', params.z, params.x, params.y);

		// get stored layer
		store.redis.get(params.layerUuid, function (err, storedLayerJSON) {	
			if (err) return pile._getTileErrorHandler(res, err);
			if (!storedLayerJSON) return pile._getTileErrorHandler(res, 'No stored layer.');

			var storedLayer = JSON.parse(storedLayerJSON);

			// get tiles
			if (type == 'pbf') ops.push(function (callback) {
				pile.getVectorTile(params, storedLayer, callback);
			});

			if (type == 'png') ops.push(function (callback) {
				pile.getRasterTile(params, storedLayer, callback);
			});

			if (type == 'grid') ops.push(function (callback) {
				pile.getGridTile(params, storedLayer, callback);
			});


			// run ops
			async.series(ops, function (err, data) {
				var data = data[0];

				if (err) {
					console.log('ASYCN ERR', err);
					return res.end();
				}

				// send to client
				res.writeHead(200, {'Content-Type': pile.headers[type]});
				res.end(data);
			});
		});
		
	},


	_getTileErrorHandler : function (res, err) {
		console.log('_getTileErrorHandler err:', err);
		res.end();
	},


	createVectorTile : function (params, storedLayer, done) {

		// KUE: create raster tile
		var start = new Date().getTime();
		var job = jobs.create('render_vector_tile', { // todo: cluster up with other machines, pluggable clusters
			params : params,
			storedLayer : storedLayer
		}).priority('high').attempts(5).save();


		// KUE DONE: raster created
		job.on('complete', function (result) {

			// stats
			var end = new Date().getTime();
			var create_tile_time = end - start;
			console.log('Created vector tile', create_tile_time);
			
			// get tile
			pile._readVectorTile(params, storedLayer, done);
		});


	},

	createRasterTile : function (params, storedLayer, done) {

		// KUE: create raster tile
		var start = new Date().getTime();
		var job = jobs.create('render_raster_tile', { // todo: cluster up with other machines, pluggable clusters
			params : params,
			storedLayer : storedLayer
		}).priority('high').removeOnComplete(true).attempts(5).save();


		// KUE DONE: raster created
		job.on('complete', function (result) {

			// stats
			var end = new Date().getTime();
			var create_tile_time = end - start;
			console.log('Created raster tile', create_tile_time, 'ms');
			
			// get tile
			store._readRasterTile(params, done);
		});

	},


	createGridTile : function (params, storedLayer, done) {

		// KUE: create raster tile
		var start = new Date().getTime();
		var job = jobs.create('render_grid_tile', { // todo: cluster up with other machines, pluggable clusters
			params : params,
			storedLayer : storedLayer
		}).priority('high').attempts(5).save();


		// KUE DONE: raster created
		job.on('complete', function (result) {

			// stats
			var end = new Date().getTime();
			var create_tile_time = end - start;
			console.log('Created grid tile', create_tile_time, 'ms');
			
			// get tile
			pile._getGridTileFromRedis(params, done);
		});


	},

	_renderVectorTile : function (params, done) {

		pile._prepareTile(params, function (err, map) {
			if (err) console.log('create_tile cluster fuck', err);

			var map_options = {
				variables : { 
					zoom : params.z // insert min_max etc 
				}
			}

			// vector
			var im = new mapnik.VectorTile(params.z, params.x, params.y);
			
			// check
			if (!im) return callback('Unsupported type.')

			// render
			map.render(im, map_options, function (err, tile) {

				pile._saveVectorTile(tile, params, done);
			});
		});
		
	},

	_renderRasterTile : function (params, done) {

		pile._prepareTile(params, function (err, map) {
			if (err) return done(err);
			if (!map) return done('no map 7474');

			// map options
			var map_options = {
				variables : { 
					zoom : params.z // insert min_max etc 
				}
			}

			var map_options = {
				buffer_size : 128,
				variables : { 
					zoom : params.z // insert min_max etc 
				}
			}
			
			// raster
			var im = new mapnik.Image(256, 256);

			// render
			map.render(im, map_options, function (err, tile) {
				if (err) console.log('err: ', err);
				if (err) return done(err);

				// save png to redis
				store._saveRasterTile(tile, params, done);
			});
		});
		
	},



	_renderGridTile : function (params, done) {

		pile._prepareTile(params, function (err, map) {
			if (err) console.log('create_tile cluster fuck', err);
			if (err) return done(err);
			if (!map) return done('no map 4493');

			var map_options = {
				variables : { 
					zoom : params.z // insert min_max etc 
				}
			}

			// raster
			var im = new mapnik.Grid(map.width, map.height);

			// var fields = ['gid', 'east', 'north', 'range', 'azimuth', 'vel', 'coherence', 'height', 'demerr'];
			var fields = ['gid']; // todo: this is hardcoded!, get first column instead (could be ['id'] etc)

			var map_options = {
				layer : 0,
				fields : fields,
				buffer_size : 128
			}
			
			// check
			if (!im) return callback('Unsupported type.')

			// render
			map.render(im, map_options, function (err, grid) {
				if (err) return done(err);
				if (!grid) return done('no grid 233');

				// console.log('grid : ', grid, grid.fields(), grid.painted());

				// for (g in grid) {
					// console.log('g: ', g);
				// }

				grid.encode({features : true}, function (err, utf) {
					if (err) return done(err);
					// save grid to redis
					var keyString = 'grid_tile:'  + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
					// var key = new Buffer(keyString);

					store.redis.set(keyString, JSON.stringify(utf), done);
				})
			});
		});
	},

		

	// return tiles from redis/disk or created
	getVectorTile : function (params, storedLayer, done) {

		// check redis
		store._readVectorTile(params, storedLayer, function (err, data) {

			// return data
			if (data) return done(null, data);

			// create
			pile.createVectorTile(params, storedLayer, done);
		});
	},

	getRasterTile : function (params, storedLayer, done) {

		// check cache
		store._readRasterTile(params, function (err, data) {

			// return data
			if (data) return done(null, data);
			
			// create
			pile.createRasterTile(params, storedLayer, done);
		});
	},
	
	getGridTile : function (params, storedLayer, done) {

		// check cache
		pile._getGridTileFromRedis(params, function (err, data) {

			if (data) return done(null, data);

			// create
			pile.createGridTile(params, storedLayer, done);
		});
	},



	

	// get tiles from redis
	_getRasterTileFromRedis : function (params, done) {
		var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
		var key = new Buffer(keyString);
		store.redis.get(key, done);
	},
	_getVectorTileFromRedis : function (params, done) {
		var keyString = 'vector_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
		var key = new Buffer(keyString);
		store.redis.get(key, done);
	},
	_getGridTileFromRedis : function (params, done) {
		var keyString = 'grid_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
		store.redis.get(keyString, done);
	},


	checkParams : function (params, done) {
		if (!params.layerUuid) 	return done('Invalid url: Missing layerUuid.');
		if (!params.z) 		return done('Invalid url: Missing tile coordinates.');
		if (!params.x) 		return done('Invalid url: Missing tile coordinates.');
		if (!params.y) 		return done('Invalid url: Missing tile coordinates.');
		if (!params.type) 	return done('Invalid url: Missing type extension.');
		return done(null);
	},

	_prepareTile : function (params, done) {

		// parse url into layerUuid, zxy, type
		var ops = [];
		var map,
		    layer,
		    postgis,
		    bbox;

		// check params
		if (!params.layerUuid) 	return pile.error.missingInformation(res, 'Invalid url: Missing layerUuid.');
		if (!params.z) 		return pile.error.missingInformation(res, 'Invalid url: Missing tile coordinates.');
		if (!params.x) 		return pile.error.missingInformation(res, 'Invalid url: Missing tile coordinates.');
		if (!params.y) 		return pile.error.missingInformation(res, 'Invalid url: Missing tile coordinates.');
		if (!params.type) 	return pile.error.missingInformation(res, 'Invalid url: Missing type (extension).');


		// look for stored layerUuid
		ops.push(function (callback) {
			store.redis.get(params.layerUuid, callback);
		});

		// define settings, xml
		ops.push(function (storedLayer, callback) {
			if (!storedLayer) return callback('No such layerUuid.');

			var storedLayer = JSON.parse(storedLayer);

			// default settings // todo: put in config
			var default_postgis_settings = {
				user : 'docker',
				password : 'docker',
				host : 'postgis',
				type : 'postgis',
				geometry_field : 'the_geom_3857',
				srid : '3857'
			}

			// set bounding box
			bbox = mercator.xyz_to_envelope(parseInt(params.x), parseInt(params.y), parseInt(params.z), false);

			// insert layer settings 
			var postgis_settings = default_postgis_settings;
			postgis_settings.dbname = storedLayer.options.database_name;
			postgis_settings.table 	= storedLayer.options.sql;
			postgis_settings.extent = storedLayer.options.extent;
			postgis_settings.geometry_field = storedLayer.options.geom_column;
			postgis_settings.srid = storedLayer.options.srid;
			
			// everything in spherical mercator (3857)!
			try {
				map = new mapnik.Map(256, 256, mercator.proj4);
				layer = new mapnik.Layer('layer', mercator.proj4);
				postgis = new mapnik.Datasource(postgis_settings);
				
			} catch (e) {
				return callback(e.message);
			}

			// set buffer
			map.bufferSize = 128;

			// set extent
			map.extent = bbox; // must have extent!

			// set datasource
			layer.datasource = postgis;

			// add styles
			layer.styles = ['layer']; // style names in xml
			
			// add layer to map
			map.add_layer(layer);

			// parse xml from cartocss
			pile.cartoRenderer(storedLayer.options.cartocss, layer, callback);

		});

		// load xml to map
		ops.push(function (xml, callback) {
			map.fromString(xml, {strict : true}, callback);
		});

		// run ops
		async.waterfall(ops, done);

	},


	// convert CartoCSS to Mapnik XML
	cartoRenderer : function (css, layer, callback) {

		var options = {
			// srid 3857
			"srs": "+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0.0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over",

			"Stylesheet": [{
				"id" : 'tile_style',
				"data" : css
			}],
			"Layer" : [layer]
		}

		try  {

			// carto renderer
			var xml = new carto.Renderer().render(options);

			callback(null, xml);

		} catch (e) {
			var err = { message : e }
			callback(err);
		}


	},


	// todo: old code, but we prob need this?
	getFile : function (req, res) {
		
		// get access token
		var access_token = pile._getAccessToken(req),
		    file_id = req.query.file_id,
		    ops = [];

		// no access
		if (!access_token) return pile.error.noAccess(res);

		// check for missing info
		if (!file_id) return pile.error.missingInformation(res, 'file_id');

		// todo: check permission to access file
		
		// get from wu
		pile.request.get('/api/bridge/getFile', {
			file_id : file_id,
			access_token : access_token
		}, function (err, results) {
			// console.log('pile.request.get: ', err, results);
		});
	},



	request : {

		get : function (endpoint, options, callback) {
			var baseUrl = 'http://wu:3001',
			    params = '';
			if (_.size(options)) {
				params += '?';
				var n = _.size(options);
				for (o in options) {
					params += o + '=' + options[o];
					n--;
					if (n) params += '&'
				}
			}

			request({
				method : 'GET',
				uri : baseUrl + endpoint + params
			}, function (err, response, body) {
				callback(err, body);
			}); 
		},
	},
	

	_getAccessToken : function (req) {
		var access_token = req.query.access_token || req.body.access_token;
		return access_token;
	},

	error : {

		missingInformation : function (res, missing) {
			var error = 'Missing information'
			var error_description = missing + ' Check out the documentation on https://docs.systemapic.com.';
			res.json({
				error : error,
				error_description : error_description
			});
		},

		noAccess : function (res) {
			res.json({
				error : 'Unauthenicated.'
			});
		},
	}

}

// #########################################
// ###  Initialize Kue                   ###
// #########################################
// init kue
var jobs = kue.createQueue({
   	redis : config.kueredis,
   	prefix : '_kue4'
});

// clear kue
jobs.watchStuckJobs();

// #########################################
// ###  Clusters                         ###
// #########################################
// master cluster:
if (cluster.isMaster) { 

	// start server
	server(pile);

	console.log('Cluster...'.bgYellow.black);
	for (var i = 0; i < numCPUs - 2; i++) {  // 6 cpus
		// fork workers
		cluster.fork(); 
	} 

	// listen to exit, keep alive
	cluster.on('exit', function(worker, code, signal) { 
		console.log('__________________Cluster died, respawning__________________________________'.red);
		cluster.fork(); 
	});


} else {
// worker clusters, kues:

	console.log('...clustering!'.yellow);

	// #########################################
	// ###  Kue jobs: Vector render          ###
	// #########################################
	// render vector job
	jobs.process('render_vector_tile', 1, function (job, done) {

		var params = job.data.params;
		pile._renderVectorTile(params, function (err) {
			if (err) console.log('create_tile cluster fuck', err);
			done(err);
		});
	});
	// render vector job
	jobs.process('render_raster_tile', 1, function (job, done) {

		var params = job.data.params;

		// save job by id
		var jobID = 'job_id:' + params.z + ':' + params.access_token + ':' + params.layerUuid;

		// render
		console.time('render raster tile', params.z);
		pile._renderRasterTile(params, function (err) {
			console.timeEnd('render raster tile', params.z);

			if (err) console.log('create_tile cluster fuck', err);
			
			done(null);
		});

	});
	// render vector job
	jobs.process('render_grid_tile', 1, function (job, done) {

		var params = job.data.params;
		pile._renderGridTile(params, function (err) {
			if (err) console.log('create_tile cluster fuck', err);
			done(err);
		});
	});

	// remove stale jobs
	jobs.on('job complete', function (id) {
		kue.Job.get(id, function (err, job) {
			if (err) return;

			var params = job.data.params;
			var job_id = job.id;

			job.remove( function (err) {
				if (err) console.log('job.remove err: ', err);
			});
		});
	});

}