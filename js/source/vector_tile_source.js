'use strict';

var util = require('../util/util');
var Evented = require('../util/evented');
var Source = require('./source');
var Pako = require('pako');

module.exports = VectorTileSource;

function VectorTileSource(options) {
    util.extend(this, util.pick(options, ['url', 'tileSize']));

    if (this.tileSize !== 512) {
        throw new Error('vector tile sources must have a tileSize of 512');
    }

    Source._loadTileJSON.call(this, options);
}

VectorTileSource.prototype = util.inherit(Evented, {
    minzoom: 0,
    maxzoom: 22,
    tileSize: 512,
    reparseOverscaled: true,
    _loaded: false,

    onAdd: function(map) {
        this.map = map;
    },

    loaded: function() {
        return this._pyramid && this._pyramid.loaded();
    },

    update: function(transform) {
        if (this._pyramid) {
            this._pyramid.update(this.used, transform);
        }
    },

    reload: function() {
        if (this._pyramid) {
            this._pyramid.reload();
        }
    },

    redoPlacement: function() {
        if (!this._pyramid) {
            return;
        }

        var ids = this._pyramid.orderedIDs();
        for (var i = 0; i < ids.length; i++) {
            var tile = this._pyramid.getTile(ids[i]);
            this._redoTilePlacement(tile);
        }
    },

    render: Source._renderTiles,
    featuresAt: Source._vectorFeaturesAt,
    featuresIn: Source._vectorFeaturesIn,

    _loadTile: function(tile) {
        var overscaling = tile.coord.z > this.maxzoom ? Math.pow(2, tile.coord.z - this.maxzoom) : 1;
        var params = {
            url: tile.coord.url(this.tiles, this.maxzoom),
            uid: tile.uid,
            coord: tile.coord,
            zoom: tile.coord.z,
            maxZoom: this.maxzoom,
            tileSize: this.tileSize * overscaling,
            source: this.id,
            overscaling: overscaling,
            angle: this.map.transform.angle,
            pitch: this.map.transform.pitch,
            collisionDebug: this.map.collisionDebug
        };

        if (tile.workerID) {
            this.dispatcher.send('reload tile', params, this._tileLoaded.bind(this, tile), tile.workerID);
        } else {
            var url = params.url.split('/'),
                z = url[0],
                x = url[1],
                y = url[2];
            y = (1 << z) - 1 - y;

            if (!this.db) {
                this.db = window.sqlitePlugin.openDatabase({
                    name: params.source + '.mbtiles',
                    location: 2,
                    createFromLocation: 1
                });
            }

            this.db.transaction(function(tx) {
                tx.executeSql('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?', [z, x, y], function(tx, res) {
                    var tileData = res.rows.item(0).tile_data,
                        tileDataDecoded = window.atob(tileData),
                        tileDataDecodedLength = tileDataDecoded.length,
                        tileDataTypedArray = new Uint8Array(tileDataDecodedLength);
                    for (var i = 0; i < tileDataDecodedLength; ++i) {
                        tileDataTypedArray[i] = tileDataDecoded.charCodeAt(i);
                    }
                    var tileDataInflated = Pako.inflate(tileDataTypedArray);
                    params.tileData = tileDataInflated;
                    tile.workerID = this.dispatcher.send('load tile', params, this._tileLoaded.bind(this, tile));
                }.bind(this), function(tx, e) {
                    console.log('Database Error: ' + e.message);
                });
            }.bind(this));
        }
    },

    _tileLoaded: function(tile, err, data) {
        if (tile.aborted)
            return;

        if (err) {
            this.fire('tile.error', {tile: tile});
            return;
        }

        tile.loadVectorData(data);

        if (tile.redoWhenDone) {
            tile.redoWhenDone = false;
            this._redoTilePlacement(tile);
        }

        this.fire('tile.load', {tile: tile});
    },

    _abortTile: function(tile) {
        tile.aborted = true;
        this.dispatcher.send('abort tile', { uid: tile.uid, source: this.id }, null, tile.workerID);
    },

    _addTile: function(tile) {
        this.fire('tile.add', {tile: tile});
    },

    _removeTile: function(tile) {
        this.fire('tile.remove', {tile: tile});
    },

    _unloadTile: function(tile) {
        tile.unloadVectorData(this.map.painter);
        this.glyphAtlas.removeGlyphs(tile.uid);
        this.dispatcher.send('remove tile', { uid: tile.uid, source: this.id }, null, tile.workerID);
    },

    _redoTilePlacement: function(tile) {

        if (!tile.loaded || tile.redoingPlacement) {
            tile.redoWhenDone = true;
            return;
        }

        tile.redoingPlacement = true;

        this.dispatcher.send('redo placement', {
            uid: tile.uid,
            source: this.id,
            angle: this.map.transform.angle,
            pitch: this.map.transform.pitch,
            collisionDebug: this.map.collisionDebug
        }, done.bind(this), tile.workerID);

        function done(_, data) {
            tile.reloadSymbolData(data, this.map.painter);
            this.fire('tile.load', {tile: tile});

            tile.redoingPlacement = false;
            if (tile.redoWhenDone) {
                this._redoTilePlacement(tile);
                tile.redoWhenDone = false;
            }
        }
    }
});
