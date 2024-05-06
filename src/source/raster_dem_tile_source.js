// @flow

import {getImage, getmbtileImage, ResourceType} from '../util/ajax.js';
import {extend, prevPowerOfTwo} from '../util/util.js';
import {Evented} from '../util/evented.js';
import browser from '../util/browser.js';
import window from '../util/window.js';
import offscreenCanvasSupported from '../util/offscreen_canvas_supported.js';
import {OverscaledTileID} from './tile_id.js';
import RasterTileSource from './raster_tile_source.js';
// ensure DEMData is registered for worker transfer on main thread:
import DEMData from '../data/dem_data.js';

import type {Source} from './source.js';
import type Dispatcher from '../util/dispatcher.js';
import type Tile from './tile.js';
import type {Callback} from '../types/callback.js';
import type {TextureImage} from '../render/texture.js';
import type {RasterDEMSourceSpecification} from '../style-spec/types.js';
import webpSupported from "../util/webp_supported.js";

// $FlowFixMe[method-unbinding]
class RasterDEMTileSource extends RasterTileSource implements Source {
    encoding: "mapbox" | "terrarium";

    constructor(id: string, options: RasterDEMSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super(id, options, dispatcher, eventedParent);
        this.type = 'raster-dem';
        this.maxzoom = 22;
        this._options = extend({type: 'raster-dem'}, options);
        this.encoding = options.encoding || "mapbox";
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const url = this.map._requestManager.normalizeTileURL(tile.tileID.canonical.url(this.tiles, this.scheme), false, this.tileSize);

        if (this._options.mbtiles === undefined) this._options.mbtiles = false;
        if (!this._options.mbtiles) {
            tile.request = getImage(this.map._requestManager.transformRequest(url, ResourceType.Tile), imageLoaded.bind(this));
        } else {
            let Rurl = url.split('/'),
                z = Rurl[0],
                x = Rurl[1],
                y = Rurl[2];

            const database = getTerrainMbtileFile(z, x, y);
            try {
                if (window.openDatabases[database] === undefined) {
                    //do nothing because offline DEM database is not available
                    callback(null);
                    return;
                }
                if (window.openDatabases[database] === true) {
                    if (window.AppType === "CORDOVA") {
                        window.openDatabases[database] = window.sqlitePlugin.openDatabase({
                            name: `${database}.mbtiles`,
                            location: 2,
                            createFromLocation: 0,
                            androidDatabaseImplementation: 1
                        });
                    }
                }
                y = (1 << z) - 1 - y;
                if (window.AppType === "CORDOVA") {
                    window.openDatabases[database].transaction(function (tx) {
                        tx.executeSql('SELECT BASE64(tile_data) AS tile_data64 FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?', [z, x, y], function (tx, res) {

                            let tileData = res.rows.item(0).tile_data64;
                            if (tileData !== undefined) {
                                if (!webpSupported.supported) {
                                    //Because Safari doesn't support WEBP we need to convert it tiles PNG
                                    tileData = WEBPtoPNG(tileData);
                                } else {
                                    tileData = `data:image/webp;base64,${tileData}`;
                                }
                            }
                            tile.request = getmbtileImage(tileData, imageLoaded.bind(this));
                        }.bind(this), function (tx, e) {
                            console.log(`Database Error: ${e.message}`);
                        });
                    }.bind(this));
                }
            } catch (e) {
                console.log('Error:', e);
            }
        }

        // $FlowFixMe[missing-this-annot]
        function imageLoaded(err: ?Error, img: ?TextureImage, cacheControl: ?string, expires: ?string) {
            delete tile.request;
            if (tile.aborted) {
                tile.state = 'unloaded';
                callback(null);
            } else if (err) {
                tile.state = 'errored';
                callback(err);
            } else if (img) {
                if (this.map._refreshExpiredTiles) tile.setExpiryData({cacheControl, expires});
                const transfer = window.ImageBitmap && img instanceof window.ImageBitmap && offscreenCanvasSupported();
                // DEMData uses 1px padding. Handle cases with image buffer of 1 and 2 pxs, the rest assume default buffer 0
                // in order to keep the previous implementation working (no validation against tileSize).
                const buffer = (img.width - prevPowerOfTwo(img.width)) / 2;
                // padding is used in getImageData. As DEMData has 1px padding, if DEM tile buffer is 2px, discard outermost pixels.
                const padding = 1 - buffer;
                const borderReady = padding < 1;
                if (!borderReady && !tile.neighboringTiles) {
                    tile.neighboringTiles = this._getNeighboringTiles(tile.tileID);
                }

                // $FlowFixMe[incompatible-call]
                const rawImageData = transfer ? img : browser.getImageData(img, padding);
                const params = {
                    uid: tile.uid,
                    coord: tile.tileID,
                    source: this.id,
                    rawImageData,
                    encoding: this.encoding,
                    padding
                };

                if (!tile.actor || tile.state === 'expired') {
                    tile.actor = this.dispatcher.getActor();
                    tile.actor.send('loadDEMTile', params, done.bind(this), undefined, true);
                }
            }
        }

        // $FlowFixMe[missing-this-annot]
        function done(err: ?Error, dem: ?DEMData) {
            if (err) {
                tile.state = 'errored';
                callback(err);
            }

            if (dem) {
                tile.dem = dem;
                tile.dem.onDeserialize();
                tile.needsHillshadePrepare = true;
                tile.needsDEMTextureUpload = true;
                tile.state = 'loaded';
                callback(null);
            }
        }
    }

    _getNeighboringTiles(tileID: OverscaledTileID): { [number]: { backfilled: boolean } } {
        const canonical = tileID.canonical;
        const dim = Math.pow(2, canonical.z);

        const px = (canonical.x - 1 + dim) % dim;
        const pxw = canonical.x === 0 ? tileID.wrap - 1 : tileID.wrap;
        const nx = (canonical.x + 1 + dim) % dim;
        const nxw = canonical.x + 1 === dim ? tileID.wrap + 1 : tileID.wrap;

        const neighboringTiles = {};
        // add adjacent tiles
        neighboringTiles[new OverscaledTileID(tileID.overscaledZ, pxw, canonical.z, px, canonical.y).key] = {backfilled: false};
        neighboringTiles[new OverscaledTileID(tileID.overscaledZ, nxw, canonical.z, nx, canonical.y).key] = {backfilled: false};

        // Add upper neighboringTiles
        if (canonical.y > 0) {
            neighboringTiles[new OverscaledTileID(tileID.overscaledZ, pxw, canonical.z, px, canonical.y - 1).key] = {backfilled: false};
            neighboringTiles[new OverscaledTileID(tileID.overscaledZ, tileID.wrap, canonical.z, canonical.x, canonical.y - 1).key] = {backfilled: false};
            neighboringTiles[new OverscaledTileID(tileID.overscaledZ, nxw, canonical.z, nx, canonical.y - 1).key] = {backfilled: false};
        }
        // Add lower neighboringTiles
        if (canonical.y + 1 < dim) {
            neighboringTiles[new OverscaledTileID(tileID.overscaledZ, pxw, canonical.z, px, canonical.y + 1).key] = {backfilled: false};
            neighboringTiles[new OverscaledTileID(tileID.overscaledZ, tileID.wrap, canonical.z, canonical.x, canonical.y + 1).key] = {backfilled: false};
            neighboringTiles[new OverscaledTileID(tileID.overscaledZ, nxw, canonical.z, nx, canonical.y + 1).key] = {backfilled: false};
        }

        return neighboringTiles;
    }

    // $FlowFixMe[method-unbinding]
    unloadTile(tile: Tile) {
        if (tile.demTexture) this.map.painter.saveTileTexture(tile.demTexture);
        if (tile.fbo) {
            tile.fbo.destroy();
            delete tile.fbo;
        }
        if (tile.dem) delete tile.dem;
        delete tile.neighboringTiles;

        tile.state = 'unloaded';
    }

}

export default RasterDEMTileSource;
