var mapnik = require('mapnik');
var async = require('async');
var mercator = require('./sphericalmercator');
var carto = require('carto');
var fs = require('fs-extra');

// register mapnik plugins
mapnik.register_default_fonts();
mapnik.register_default_input_plugins();

var dbuser = 'systemapic';
var dbpass = 'docker'
var dbname = 'vkztdvcqkm';
// var tablename = 'snowraster';
var tablename = 'snowo';

// get tile coords
var tile = "16/34025/19345";
var split_tiles = tile.split('/');
var coords = {
    z : parseInt(split_tiles[0]),
    x : parseInt(split_tiles[1]),
    y : parseInt(split_tiles[2])
}

// set tile output path
var tilePath = 'tmp/snow-raster-error-test-' + coords.x + '-' + coords.y + '-' + coords.z + '.png';

var postgis_settings = {
        user            : dbuser,
        password        : dbpass,
        host            : 'postgis',
        srid            : '3857',
        table           : tablename,
        band            : 1,
        type            : 'pgraster',
        geometry_field  : 'rast',
        max_async_connection : 10,
        dbname          : dbname,
        clip_rasters    : 'true',
        prescale_rasters : 'true'
}

// create map, layer, datasource
var map = new mapnik.Map(256, 256, mercator.proj4);
var layer = new mapnik.Layer('layer', mercator.proj4);
var postgis = new mapnik.Datasource(postgis_settings);
        
// set buffer
map.bufferSize = 128;

// set bounding box
bbox = mercator.xyz_to_envelope(coords.x, coords.y, coords.z, false);

// set extent
map.extent = bbox; // must have extent!

// set datasource
layer.datasource = postgis;

// add styles
layer.styles = ['layer']; // style names in xml

// add layer to map
map.add_layer(layer);

// style
var css =  '#layer {raster-opacity: 1;raster-colorizer-default-mode: linear;raster-colorizer-default-color: transparent;raster-comp-op: color-dodge;raster-colorizer-stops:stop(0, rgba(0,0,0,0))stop(99, rgba(0,0,0,0))stop(100, rgba(255,255,255,0))stop(161, rgba(255,255,255,1))stop(200, rgba(255,92,0,1))stop(201, rgba(0,0,0,0))stop(255, rgba(0,0,0,0), exact);}';

// carto options
var options = {
        "Stylesheet": [{
                "id" : 'tile_style',
                "data" : css
        }],
        "Layer" : [layer]
}

// carto renderer
var xml = new carto.Renderer().render(options);

// import xml
map.fromString(xml, {strict : true}, function (err, map) {

    // map options
    var map_options = {
            buffer_size : 128,
    }
    
    // raster
    var im = new mapnik.Image(256, 256);

    // render
    map.render(im, map_options, function (err, tile) {

         // encode tile
        tile.encode('png8', function (err, buffer) {
            if (err) console.log('tile.encode err:', err);

            // save to disk
            fs.outputFile(tilePath, buffer, function (err) {
                console.log('done', tilePath);
            });
        });

    });
});
