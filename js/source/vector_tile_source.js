'use strict';

const Evented = require('../util/evented');
const util = require('../util/util');
const loadTileJSON = require('./load_tilejson');
const normalizeURL = require('../util/mapbox').normalizeTileURL;
const Pako = require('pako');

class VectorTileSource extends Evented {

    constructor(id, options, dispatcher, eventedParent) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;

        this.type = 'vector';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this.reparseOverscaled = true;
        this.isTileClipped = true;
        util.extend(this, util.pick(options, ['url', 'scheme', 'tileSize']));

        this._options = util.extend({ type: 'vector' }, options);

        if (this.tileSize !== 512) {
            throw new Error('vector tile sources must have a tileSize of 512');
        }

        this.setEventedParent(eventedParent);
    }

    load() {
        this.fire('dataloading', {dataType: 'source'});

        loadTileJSON(this._options, (err, tileJSON) => {
            if (err) {
                this.fire('error', err);
                return;
            }
            util.extend(this, tileJSON);
            this.fire('data', {dataType: 'source'});
            this.fire('source.load');
        });
    }

    onAdd(map) {
        this.load();
        this.map = map;
    }

    serialize() {
        return util.extend({}, this._options);
    }

    loadTile(tile, callback) {
        const overscaling = tile.coord.z > this.maxzoom ? Math.pow(2, tile.coord.z - this.maxzoom) : 1;
        const params = {
            url: normalizeURL(tile.coord.url(this.tiles, this.maxzoom, this.scheme), this.url),
            uid: tile.uid,
            coord: tile.coord,
            zoom: tile.coord.z,
            tileSize: this.tileSize * overscaling,
            type: this.type,
            source: this.id,
            overscaling: overscaling,
            angle: this.map.transform.angle,
            pitch: this.map.transform.pitch,
            showCollisionBoxes: this.map.showCollisionBoxes
        };

        if (!tile.workerID) {
            var ONLINE = false;
            if (ONLINE){
                tile.workerID = this.dispatcher.send('loadTile', params, done.bind(this));
            }else{
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
        } else if (tile.state === 'loading') {
            // schedule tile reloading after it has been loaded
            tile.reloadCallback = callback;
        } else {
            this.dispatcher.send('reloadTile', params, done.bind(this), tile.workerID);
        }

        function done(err, data) {
            if (tile.aborted)
                return;

            if (err) {
                return callback(err);
            }

            tile.loadVectorData(data, this.map.painter);

            if (tile.redoWhenDone) {
                tile.redoWhenDone = false;
                tile.redoPlacement(this);
            }

            callback(null);

            if (tile.reloadCallback) {
                this.loadTile(tile, tile.reloadCallback);
                tile.reloadCallback = null;
            }
        }
    }

    abortTile(tile) {
        this.dispatcher.send('abortTile', { uid: tile.uid, type: this.type, source: this.id }, null, tile.workerID);
    }

    unloadTile(tile) {
        tile.unloadVectorData();
        this.dispatcher.send('removeTile', { uid: tile.uid, type: this.type, source: this.id }, null, tile.workerID);
    }
}

module.exports = VectorTileSource;
