import {test} from '../../util/test.js';
import browser from '../../../src/util/browser.js';

test('browser', (t) => {
    t.test('frame', (t) => {
        const id = browser.frame(() => {
            t.pass('called frame');
            t.ok(id, 'returns id');
            t.end();
        });
    });

    t.test('now', (t) => {
        t.equal(typeof browser.now(), 'number');
        t.end();
    });

    t.test('frame', (t) => {
        const frame = browser.frame(() => {
            t.fail();
        });
        frame.cancel();
        t.end();
    });

    t.test('devicePixelRatio', (t) => {
        t.equal(typeof browser.devicePixelRatio, 'number');
        t.end();
    });

    t.end();
});
