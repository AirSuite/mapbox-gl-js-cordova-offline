// @flow

import {extend, pick} from '../util/util';

import { getImage, getmbtileImage, getUint8ArrayImage, ResourceType } from '../util/ajax';
import { Event, ErrorEvent, Evented } from '../util/evented';
import loadTileJSON from './load_tilejson';
import {postTurnstileEvent, postMapLoadEvent} from '../util/mapbox';
import TileBounds from './tile_bounds';
import Texture from '../render/texture';
import webpSupported from '../util/webp_supported';

import {cacheEntryPossiblyAdded} from '../util/tile_request_cache';

import type {Source} from './source';
import type {OverscaledTileID} from './tile_id';
import type Map from '../ui/map';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type {Callback} from '../types/callback';
import type {Cancelable} from '../types/cancelable';
import type {
    RasterSourceSpecification,
    RasterDEMSourceSpecification
} from '../style-spec/types';

class RasterTileSource extends Evented implements Source {
    type: 'raster' | 'raster-dem';
    id: string;
    minzoom: number;
    maxzoom: number;
    url: string;
    scheme: string;
    tileSize: number;

    bounds: ?[number, number, number, number];
    tileBounds: TileBounds;
    roundZoom: boolean;
    dispatcher: Dispatcher;
    map: Map;
    tiles: Array<string>;

    _loaded: boolean;
    _options: RasterSourceSpecification | RasterDEMSourceSpecification;
    _tileJSONRequest: ?Cancelable;

    constructor(id: string, options: RasterSourceSpecification | RasterDEMSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;
        this.setEventedParent(eventedParent);

        this.type = 'raster';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.roundZoom = true;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this._loaded = false;

        this._options = extend({type: 'raster'}, options);
        extend(this, pick(options, ['url', 'scheme', 'tileSize']));
    }

    load() {
        this._loaded = false;
        this.fire(new Event('dataloading', {dataType: 'source'}));
        this._tileJSONRequest = loadTileJSON(this._options, this.map._requestManager, (err, tileJSON) => {
            this._tileJSONRequest = null;
            this._loaded = true;
            if (err) {
                this.fire(new ErrorEvent(err));
            } else if (tileJSON) {
                extend(this, tileJSON);
                if (tileJSON.bounds) this.tileBounds = new TileBounds(tileJSON.bounds, this.minzoom, this.maxzoom);

                postTurnstileEvent(tileJSON.tiles);
                postMapLoadEvent(tileJSON.tiles, this.map._getMapId(), this.map._requestManager._skuToken);

                // `content` is included here to prevent a race condition where `Style#_updateSources` is called
                // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
                // ref: https://github.com/mapbox/mapbox-gl-js/pull/4347#discussion_r104418088
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
            }
        });
    }

    loaded(): boolean {
        return this._loaded;
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

    hasTile(tileID: OverscaledTileID) {
        return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
    }

    loadTile(tile: Tile, callback: Callback<void>) {

    const url = this.map._requestManager.normalizeTileURL(tile.tileID.canonical.url(this.tiles, this.scheme), this.url, this.tileSize);
        if (this._options.mbtiles == undefined) this._options.mbtiles = false;
        if (!this._options.mbtiles){
          tile.request = getImage(this.map._requestManager.transformRequest(url, ResourceType.Tile), done.bind(this));
        }else{
          let Rurl = url.split('/'),
          z = Rurl[0],
          x = Rurl[1],
          y = Rurl[2];
          y = (1 << z) - 1 - y;
          //console.log(Rurl);
          var database = this.id;
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

                      var tileData = res.rows.item(0).tile_data64;
                      if (tileData != undefined){
                          if (!webpSupported.supported){
                              //Because Safari doesn't support WEBP we need to convert it tiles PNG
                              tileData = WEBPtoPNG(tileData);
                          }else{
                              tileData = "data:image/png;base64," + tileData;
                          }
                      }
                      tile.request = getmbtileImage(tileData, done.bind(this));
                  }.bind(this), function(tx, e) {
                      console.log('Database Error: ' + e.message);
                  });
              }.bind(this));
            }
            if (window.AppType == "ELECTRON"){
                window.openDatabases[database].parallelize(function(){
                    window.openDatabases[database].all('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?', [z, x, y], function(tx, res) {
                        var tileData;
                        if (res != undefined) {
                          if (res.length > 0) tileData = res[0].tile_data;
                        }
                        tile.request = getUint8ArrayImage(tileData, done.bind(this));
                    }.bind(this));
                }.bind(this));
            }
        }

        function done(err, img) {
            delete tile.request;

            if (tile.aborted) {
                tile.state = 'unloaded';
                callback(null);
            } else if (err) {
                tile.state = 'errored';
                callback(err);
            } else if (img) {
                if (this.map._refreshExpiredTiles) tile.setExpiryData(img);
                delete (img: any).cacheControl;
                delete (img: any).expires;

                const context = this.map.painter.context;
                const gl = context.gl;
                tile.texture = this.map.painter.getTileTexture(img.width);
                if (tile.texture) {
                    tile.texture.update(img, {useMipmap: true});
                } else {
                    tile.texture = new Texture(context, img, gl.RGBA, {useMipmap: true});
                    tile.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_NEAREST);

                    if (context.extTextureFilterAnisotropic) {
                        gl.texParameterf(gl.TEXTURE_2D, context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, context.extTextureFilterAnisotropicMax);
                    }
                }

                tile.state = 'loaded';

                cacheEntryPossiblyAdded(this.dispatcher);

                callback(null);
            }
        }
    }

    abortTile(tile: Tile, callback: Callback<void>) {
        if (tile.request) {
            tile.request.cancel();
            delete tile.request;
        }
        callback();
    }

    unloadTile(tile: Tile, callback: Callback<void>) {
        if (tile.texture) this.map.painter.saveTileTexture(tile.texture);
        callback();
    }

    hasTransition() {
        return false;
    }
}

export default RasterTileSource;
