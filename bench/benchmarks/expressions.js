// @flow

import Benchmark from '../lib/benchmark.js';

import spec from '../../src/style-spec/reference/latest.js';
import convertFunction from '../../src/style-spec/function/convert.js';
import {isFunction, createFunction} from '../../src/style-spec/function/index.js';
import {createPropertyExpression} from '../../src/style-spec/expression/index.js';
import fetchStyle from '../lib/fetch_style.js';

import type {StyleSpecification} from '../../src/style-spec/types.js';
import type {StylePropertySpecification} from '../../src/style-spec/style-spec.js';
import type {StylePropertyExpression} from '../../src/style-spec/expression/index.js';

class ExpressionBenchmark extends Benchmark {
    data: Array<{
        propertySpec: StylePropertySpecification,
        rawValue: mixed,
        rawExpression: mixed,
        compiledFunction: StylePropertyExpression,
        compiledExpression: StylePropertyExpression
    }>;
    style: string | StyleSpecification;

    constructor(style: string | StyleSpecification) {
        super();
        this.style = style;
    }

    setup() {
        return fetchStyle(this.style)
            .then(json => {
                this.data = [];

                for (const layer of json.layers) {
                    // some older layers still use the deprecated `ref property` instead of `type`
                    // if we don't filter out these older layers, the logic below will cause a fatal error
                    if (!layer.type) {
                        continue;
                    }

                    const expressionData = function(rawValue, propertySpec: StylePropertySpecification) {
                        const rawExpression = convertFunction(rawValue, propertySpec);
                        const compiledFunction = createFunction(rawValue, propertySpec);
                        const compiledExpression = createPropertyExpression(rawExpression, propertySpec);
                        if (compiledExpression.result === 'error') {
                            throw new Error(compiledExpression.value.map(err => `${err.key}: ${err.message}`).join(', '));
                        }
                        return {
                            propertySpec,
                            rawValue,
                            rawExpression,
                            compiledFunction,
                            compiledExpression: compiledExpression.value
                        };
                    };

                    for (const key in layer.paint) {
                        if (isFunction(layer.paint[key])) {
                            this.data.push(expressionData(layer.paint[key], spec[`paint_${layer.type}`][key]));
                        }
                    }

                    for (const key in layer.layout) {
                        if (isFunction(layer.layout[key])) {
                            this.data.push(expressionData(layer.layout[key], spec[`layout_${layer.type}`][key]));
                        }
                    }
                }
            });
    }
}

export class FunctionCreate extends ExpressionBenchmark {
    bench() {
        for (const {rawValue, propertySpec} of this.data) {
            createFunction(rawValue, propertySpec);
        }
    }
}

export class FunctionEvaluate extends ExpressionBenchmark {
    bench() {
        for (const {compiledFunction} of this.data) {
            compiledFunction.evaluate({zoom: 0});
        }
    }
}

export class ExpressionCreate extends ExpressionBenchmark {
    bench() {
        for (const {rawExpression, propertySpec} of this.data) {
            createPropertyExpression(rawExpression, propertySpec);
        }
    }
}

export class ExpressionEvaluate extends ExpressionBenchmark {
    bench() {
        for (const {compiledExpression} of this.data) {
            compiledExpression.evaluate({zoom: 0});
        }
    }
}
