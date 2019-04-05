// @flow

import { Event, ErrorEvent, Evented } from '../util/evented';

import { extend, pick } from '../util/util';
import loadTileJSON from './load_tilejson';
import { normalizeTileURL as normalizeURL, postTurnstileEvent, postMapLoadEvent } from '../util/mapbox';
import TileBounds from './tile_bounds';
import { ResourceType } from '../util/ajax';
import browser from '../util/browser';

import type {Source} from './source';
import type {OverscaledTileID} from './tile_id';
import type Map from '../ui/map';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type {Callback} from '../types/callback';
import type {Cancelable} from '../types/cancelable';
import type {VectorSourceSpecification} from '../style-spec/types';

import Pako from 'pako';

class VectorTileSource extends Evented implements Source {
    type: 'vector';
    id: string;
    minzoom: number;
    maxzoom: number;
    url: string;
    scheme: string;
    tileSize: number;

    _options: VectorSourceSpecification;
    _collectResourceTiming: boolean;
    dispatcher: Dispatcher;
    map: Map;
    bounds: ?[number, number, number, number];
    tiles: Array<string>;
    tileBounds: TileBounds;
    reparseOverscaled: boolean;
    isTileClipped: boolean;
    _tileJSONRequest: ?Cancelable;

    constructor(id: string, options: VectorSourceSpecification & {collectResourceTiming: boolean}, dispatcher: Dispatcher, eventedParent: Evented) {
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

        extend(this, pick(options, ['url', 'scheme', 'tileSize']));
        this._options = extend({ type: 'vector' }, options);

        this._collectResourceTiming = options.collectResourceTiming;

        if (this.tileSize !== 512) {
            throw new Error('vector tile sources must have a tileSize of 512');
        }

        this.setEventedParent(eventedParent);
    }

    load() {
        this.fire(new Event('dataloading', {dataType: 'source'}));
        this._tileJSONRequest = loadTileJSON(this._options, this.map._transformRequest, (err, tileJSON) => {
            this._tileJSONRequest = null;
            if (err) {
                this.fire(new ErrorEvent(err));
            } else if (tileJSON) {
                extend(this, tileJSON);
                if (tileJSON.bounds) this.tileBounds = new TileBounds(tileJSON.bounds, this.minzoom, this.maxzoom);

                postTurnstileEvent(tileJSON.tiles);
                postMapLoadEvent(tileJSON.tiles, this.map._getMapId());

                // `content` is included here to prevent a race condition where `Style#_updateSources` is called
                // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
                // ref: https://github.com/mapbox/mapbox-gl-js/pull/4347#discussion_r104418088
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
            }
        });
    }

    hasTile(tileID: OverscaledTileID) {
        return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    onRemove() {
        if (this._tileJSONRequest) {
            this._tileJSONRequest.cancel();
            this._tileJSONRequest = null;
        }
    }

    serialize() {
        return extend({}, this._options);
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const url = normalizeURL(tile.tileID.canonical.url(this.tiles, this.scheme), this.url);
        const params = {
            request: this.map._transformRequest(url, ResourceType.Tile),
            uid: tile.uid,
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            tileSize: this.tileSize * tile.tileID.overscaleFactor(),
            type: this.type,
            source: this.id,
            pixelRatio: browser.devicePixelRatio,
            showCollisionBoxes: this.map.showCollisionBoxes,
            mbtiles: this._options.mbtiles
        };
        params.request.collectResourceTiming = this._collectResourceTiming;

        if (tile.workerID === undefined || tile.state === 'expired') {
          if (!params.mbtiles){
              tile.workerID = this.dispatcher.send('loadTile', params, done.bind(this));
          }else{
              let Rurl = url.split('/'),
              z = Rurl[0],
              x = Rurl[1],
              y = Rurl[2];
              y = (1 << z) - 1 - y;
              var database = params.source;
              if (window.openDatabases[database] === undefined) {
                if (window.AppType == "CORDOVA"){
                    window.openDatabases[database] = window.sqlitePlugin.openDatabase({
                        name: database + '.mbtiles',
                        location: 2,
                        createFromLocation: 0,
                        androidDatabaseImplementation: 1
                    });
                }
                if (window.AppType == "ELECTRON"){
                    window.openDatabases[database] = new sqlite3.Database(app.getPath("userData") + '/' + database + '.mbtiles', sqlite3.OPEN_READONLY);
                }
              }
              if (window.AppType == "CORDOVA"){
                  window.openDatabases[database].transaction(function(tx) {
                      tx.executeSql('SELECT BASE64(tile_data) AS tile_data64 FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?', [z, x, y], function(tx, res) {
                          var tileData = res.rows.item(0).tile_data64,
                              tileDataDecoded = window.atob(tileData),
                              tileDataDecodedLength = tileDataDecoded.length,
                              tileDataTypedArray = new Uint8Array(tileDataDecodedLength);
                          for (var i = 0; i < tileDataDecodedLength; ++i) {
                              tileDataTypedArray[i] = tileDataDecoded.charCodeAt(i);
                          }
                          var tileDataInflated = Pako.inflate(tileDataTypedArray);
                          params.tileData = tileDataInflated;
                          tile.workerID = tile.workerID = this.dispatcher.send('loadTile', params, done.bind(this));
                      }.bind(this), function(tx, e) {
                          console.log('Database Error: ' + e.message);
                      });
                  }.bind(this));
              }
              if (window.AppType == "ELECTRON"){
                  window.openDatabases[database].parallelize(function() {
                    window.openDatabases[database].all('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?', [z, x, y], function(tx, res) {
                        var tileData
                        if (res != undefined) {
                          if (res.length > 0) tileData = res[0].tile_data;
                        }
                        var tileDataInflated = Pako.inflate(tileData);
                        params.tileData = tileDataInflated;
                        tile.workerID = tile.workerID = this.dispatcher.send('loadTile', params, done.bind(this));
                    }.bind(this));
                  }.bind(this));
              }
          }
      } else if (tile.state === 'loading') {
          // schedule tile reloading after it has been loaded
          tile.reloadCallback = callback;
      } else {
          this.dispatcher.send('reloadTile', params, done.bind(this), tile.workerID);
      }

        function done(err, data) {
            if (tile.aborted)
                return callback(null);

            if (err && err.status !== 404) {
                return callback(err);
            }

            if (data && data.resourceTiming)
                tile.resourceTiming = data.resourceTiming;

            if (this.map._refreshExpiredTiles && data) tile.setExpiryData(data);
            tile.loadVectorData(data, this.map.painter);

            callback(null);

            if (tile.reloadCallback) {
                this.loadTile(tile, tile.reloadCallback);
                tile.reloadCallback = null;
            }
        }
    }

    abortTile(tile: Tile) {
        this.dispatcher.send('abortTile', { uid: tile.uid, type: this.type, source: this.id }, undefined, tile.workerID);
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        this.dispatcher.send('removeTile', { uid: tile.uid, type: this.type, source: this.id }, undefined, tile.workerID);
    }

    hasTransition() {
        return false;
    }
}

export default VectorTileSource;
