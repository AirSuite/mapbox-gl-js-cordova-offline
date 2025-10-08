import {getImage, getmbtileImage, ResourceType} from '../util/ajax';
import {getExpiryDataFromHeaders, prevPowerOfTwo} from '../util/util';
import browser from '../util/browser';
import offscreenCanvasSupported from '../util/offscreen_canvas_supported';
import {OverscaledTileID} from './tile_id';
import RasterTileSource from './raster_tile_source';
// Import DEMData as a module with side effects to ensure
// it's registered as a serializable class on the main thread
import '../data/dem_data';

import type {Evented} from '../util/evented';
import type DEMData from '../data/dem_data';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type {Callback} from '../types/callback';
import type {TextureImage} from '../render/texture';
import type {RasterDEMSourceSpecification} from '../style-spec/types';
import type {WorkerSourceDEMTileRequest} from './worker_source';

class RasterDEMTileSource extends RasterTileSource<'raster-dem'> {
    encoding: 'mapbox' | 'terrarium';

    constructor(id: string, options: RasterDEMSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super(id, options, dispatcher, eventedParent);
        this.type = 'raster-dem';
        this.maxzoom = 22;
        this._options = Object.assign({type: 'raster-dem'}, options);
        this.encoding = options.encoding || "mapbox";
    }

    override loadTile(tile: Tile, callback: Callback<undefined>) {
        const url = this.map._requestManager.normalizeTileURL(tile.tileID.canonical.url(this.tiles, this.scheme), false, this.tileSize);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument

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
                    //console.log('No DEM', database, z, x, y);
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
                                tileData = `data:image/webp;base64,${tileData}`;
                                tile.request = getmbtileImage(tileData, imageLoaded.bind(this));
                            } else {
                                //console.log('No Tile', database, z, x, y);
                                callback(null);
                            }
                        }.bind(this), function (tx, e) {
                            console.log(`Database Error: ${e.message}`);
                            callback(null);
                        });
                    }.bind(this));
                } else {
                    if (window.DATABASE_QUEUE[database] === undefined) {
                        window.DATABASE_QUEUE[database] = 0;
                    } else {
                        window.DATABASE_QUEUE[database] += 1;
                    }
                    const thisI = this;
                    const query = `SELECT tile_data AS tile_dataUint8Array
                                 FROM images
                                          LEFT OUTER JOIN map ON images.tile_id = map.tile_id
                                 WHERE map.zoom_level = ${z}
                                   AND map.tile_column = ${x}
                                   AND map.tile_row = ${y}`;
                    setTimeout(function () {
                        window.vueApp.utilities.sqlite.open(`${database}.mbtiles`).then((connection) => {
                            connection.query(query)
                                .then((res) => {
                                    if (window.DATABASE_QUEUE[database] > 0) window.DATABASE_QUEUE[database] -= 1;
                                    if (res[0] !== undefined) {
                                        let tileData = btoa(String.fromCharCode.apply(null, res[0].tile_dataUint8Array));
                                        tileData = `data:image/webp;base64,${tileData}`;
                                        tile.request = getmbtileImage(tileData, imageLoaded.bind(thisI));
                                    } else {
                                        callback(null);
                                    }
                                })
                                .catch((e) => {
                                    if (window.DATABASE_QUEUE[database] > 0) window.DATABASE_QUEUE[database] -= 1;
                                    //console.log(`Database Error: ${e.message}`);
                                    callback(null);
                                });
                        });
                    }, window.DATABASE_QUEUE[database] * window.DATABASE_QUEUE_LENGTH);
                }
            } catch (e) {
                console.log('Error:', e);
                callback(null);
            }
        }

        function imageLoaded(
            err?: Error | null,
            img?: TextureImage | null,
            responseHeaders?: Headers,
        ) {
            delete tile.request;
            if (tile.aborted) {
                tile.state = 'unloaded';
                callback(null);
            } else if (err) {
                tile.state = 'errored';
                callback(err);
            } else if (img) {
                const expiryData = getExpiryDataFromHeaders(responseHeaders);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                if (this.map._refreshExpiredTiles) tile.setExpiryData(expiryData);
                const transfer = ImageBitmap && img instanceof ImageBitmap && offscreenCanvasSupported();
                // DEMData uses 1px padding. Handle cases with image buffer of 1 and 2 pxs, the rest assume default buffer 0
                // in order to keep the previous implementation working (no validation against tileSize).
                const buffer = (img.width - prevPowerOfTwo(img.width)) / 2;
                // padding is used in getImageData. As DEMData has 1px padding, if DEM tile buffer is 2px, discard outermost pixels.
                const padding = 1 - buffer;
                const borderReady = padding < 1;
                if (!borderReady && !tile.neighboringTiles) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                    tile.neighboringTiles = this._getNeighboringTiles(tile.tileID);
                }

                // @ts-expect-error - TS2345 - Argument of type 'TextureImage' is not assignable to parameter of type 'CanvasImageSource'.
                const rawImageData = transfer ? img : browser.getImageData(img, padding);
                const params: WorkerSourceDEMTileRequest = {
                    uid: tile.uid,
                    tileID: tile.tileID,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                    source: this.id,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                    type: this.type,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                    scope: this.scope,
                    rawImageData,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                    encoding: this.encoding,
                    padding
                };

                if (!tile.actor || tile.state === 'expired') {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                    tile.actor = this.dispatcher.getActor();
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                    tile.actor.send('loadTile', params, done.bind(this), undefined, true);
                }
            }
        }

        function done(err?: Error | null, dem?: DEMData | null) {
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

    _getNeighboringTiles(tileID: OverscaledTileID): {[key: number]: {backfilled: boolean}} {
        const canonical = tileID.canonical;
        const dim = Math.pow(2, canonical.z);

        const px = (canonical.x - 1 + dim) % dim;
        const pxw = canonical.x === 0 ? tileID.wrap - 1 : tileID.wrap;
        const nx = (canonical.x + 1 + dim) % dim;
        const nxw = canonical.x + 1 === dim ? tileID.wrap + 1 : tileID.wrap;

        const neighboringTiles: Record<string, {backfilled: boolean}> = {};
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
}

export default RasterDEMTileSource;
