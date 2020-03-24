'use strict';

const async = require('async');
const path = require('path');
const thing = require('core-util-is');
const utils = require('swaggerize-routes/lib/utils');
const pathRegexp = require('path-to-regexp');

let errorName;

/**
 * Makes default accessor functions for a specific data location, e.g. query, params etc
 * @param dataLoc
 * @returns {{get: get, set: set}}
 */
function defaultAccessor(dataLoc) {
    return {
        get: function(req, key) {
            return req[dataLoc][key];
        },
        set: function(req, key, val) {
            req[dataLoc][key] = val;
        }
    };
}

function valueAccessor(param, consumes) {
    if (param.in === 'path') {
        return defaultAccessor('params');
    }
    if (param.in === 'query') {
        return defaultAccessor('query');
    }
    if (param.in === 'header') {
        return {
            get: function(req, key) {
                return req.header(key);
            },
            set: function(req, key) {
              // noop
            }
        };
    }
    if (param.in === 'body') {
        return {
            get: function(req) {
                return req.body;
            },
            set: function(req, key, val) {
                req.body = val;
            }
        };
    }
    if (param.in === 'formData') {
        return {
            get: function(req, key) {
                var file = req.file || Array.isArray(req.files) && req.files[0];
                if (param.type === 'file' &&
                    !thing.isNullOrUndefined(file.fieldname) &&
                    file.fieldname === key) {

                    if (file.buffer) {
                        // when using InMemory option you get back a raw Buffer
                        // convert to binary string so that validator does not fail
                        // based on type.
                        return file.buffer.toString('binary');
                    }
                    return file.path;
                }
                return req.body[key];
            },
            set: function(req, key, val) {
                req.body[key] = param.type === 'file' ? val.value : val;
            }
        };
    }
}


/**
 * Makes a validator function, to validate data input per the Swagger API spec.
 * @param {{}} validator
 * @returns {function}
 * 
 * Modified by: Todd Bagley
 */
function makeValidator(validator, consumes) {
    var parameter, validate;

    parameter = validator.parameter;
    validate = validator.validate;

    function validateInput(req, res, next) {
        var accessor, value;

        accessor = valueAccessor(parameter, consumes);
        value = accessor.get(req, parameter.name);

        validate(value, function (error, newvalue) {
            if (error) {
                const err = {
                    detail: error.details && error.details[0] && error.details[0].message || 'Validation Error',
                    status: 400,
                    title: error.name || 'Bad Request'    
                };
                if (parameter.name && parameter.name.toLowerCase() === 'content-type') {
                    err.status = 415;
                    err.title = 'Unsupported Media Type';
                }
                if (parameter.required && !value) {
                    err.status = 400;
                    err.title = 'Missing Value for Required Header';
                }
                return res.status(err.status).send({ errors: [err] });
            }

            accessor.set(req, parameter.name, newvalue);
            next();
        });
    }

    return validateInput;
}

/**
 * Builds a complete path for route usage from the mountpath and the path
 * @param mountpath
 * @param path
 * @return complete route path
 */
function buildRoutePath(mountpath, path) {
    return mountpath + utils.prefix(path.replace(/{([^}]+)}/g, ':$1'), '/');
}

function error(httpStatusCode, title, description) {
    const error = new Error();
    error.description = description;
    error.name = errorName || 'SwaggerizeExpressVmt';
    error.status = httpStatusCode;
    error.title = title;
    return error;
}

/**
 * Creates a new Express route and adds it to the router.
 * @param router
 * @param mountpath
 * @param routeSpec
 */
function makeExpressRoute(router, mountpath, route, securityDefinitions) {
    var path, args, before, validators;

    path = buildRoutePath(mountpath, route.path);
    args = [path];
    before = [];

    if (route.security) {
        before.push(authorizeFor(route.security, securityDefinitions));
    }

    if (thing.isArray(route.handler)) {
        if (route.handler.length > 1) {
            Array.prototype.push.apply(before, route.handler.slice(0, route.handler.length - 1));
        }
        route.handler = route.handler[route.handler.length - 1];
    }

    validators = [];

    for (var i = 0; i < route.validators.length; ++i) {
        validators.push(makeValidator(route.validators[i], route.consumes));
    }

    before = before.concat(validators);


    Array.prototype.push.apply(args, before);
    args.push(route.handler);
    router[route.method].apply(router, args);
}

/**
 * Builds the middleware to manage not allowed calls that use wrong Method
 * @param methods - list of avalaible method for this request
 * @return {function}
 */
function buildNotAllowedMiddleware(methods) {    
    return function (req, res, next) {
        if (!req._expressroutes && methods.indexOf(req.method.toLowerCase()) === -1) {
            res.set('Allow', methods.join(', ').toUpperCase());
            res.sendStatus(405).end();
            return next(
                error(
                    405,
                    'Method Not Allowed',
                    `Method Not Allowed (valid methods: '${methods.join(', ').toUpperCase()}')`
                )
            );
        }
        if (!req._expressroutes) {
            req._expressroutes = 0;            
        }
        req._expressroutes++;
        return next();
    };
}

/**
 * Validates Media Type client declares the format to be consumed by server
 * - format of body sent from client to the server
 * @param mediaTypes
 * 
 * author: Todd Bagley
 */
function validateContentTypeHeaderMiddleware(consumes) {
    return function (req, res, next) {
        const method = req.method && req.method.toLowerCase();
        const mediaTypes = consumes[method] || [];
        let headers = req.header('content-type');
        headers = headers ? headers.split(', ') : [];
        if (headers && headers.indexOf('*/*') === -1) {
            switch (req.method.toLowerCase()) {
                case 'patch':
                case 'post':
                case 'put':
                    let validated = false;
                    for (let i=0; i<headers.length; i++) {
                        mediaTypes.forEach(mediaType => {
                            if (headers[i].includes(mediaType)) {
                                validated = true;
                            }
                        });
                    }
                    if (!req._expressroutes && !validated) {
                        return next(
                            error(
                                415,
                                'Unsupported Content-Type header',
                                `Unsupported Content-Type header: '${headers.join(", ")}' (valid media types: '${mediaTypes.join("', '")}')`
                            )
                        );
                    }        
                    break;
            }    
        }
        return next();
    };
}

/**
 * Validates Media Type client requests to be returned by server
 * - requested format of response to client from the server
 * @param mediaTypes
 * 
 * author: Todd Bagley
 */
function validateAcceptHeaderMiddleware(produces, consumes) {
    return function (req, res, next) {
        const method = req.method && req.method.toLowerCase();
        const mediaTypes = produces[method] || consumes[method] || [];    
        let headers = req.header('accept');
        headers = headers ? headers.split(', ') : [];
        if (headers && headers.indexOf('*/*') === -1) {
            let validated = false;
            for (let i=0; i<headers.length; i++) {
                mediaTypes.forEach(mediaType => {
                    if (headers[i].includes(mediaType)) {
                        validated = true;
                    }
                });
            }
            if (!validated) {
                return next(
                    error(
                        406,
                        'Unsupported Accept header',
                        `Unsupported Accept header: '${headers.join(", ")}' (valid media types: '${mediaTypes.join("', '")}')`
                    )
                );
            }        
        }

        next();
    };
}

/**
 * Adds corresponding swagger definition to the req object
 * 
 * author: Todd Bagley
 */
function appendSwaggerDefinitionsToReq(routePath, swaggerDefinitions) {
    return function(req, res, next) {
        const route = routeFilter(routePath).replace(swaggerDefinitions && swaggerDefinitions.basePath, '');
        const key = Object.keys(swaggerDefinitions && swaggerDefinitions.paths)
            .filter(path => {
                if (routeFilter(path) === route) {
                    return swaggerDefinitions && swaggerDefinitions.paths && swaggerDefinitions.paths[path];
                }
            });
            const swaggerDefinitionForRoute = swaggerDefinitions && swaggerDefinitions.paths && swaggerDefinitions.paths[key && key[0]] || {};
            req.swaggerDefinition = swaggerDefinitionForRoute && swaggerDefinitionForRoute[req.method && req.method.toLowerCase()];
            next();
    };
}

/**
 * standardizes routes with /:id or /{id} to enable comparison 
 * 
 * author: Todd Bagley
 */
function routeFilter(route) {
    let out = '';
    route.split('/')
        .forEach(level => {
            if (level) {
                switch (level[0]) {
                    case ':':
                    case '{':
                        out = `${out}/:x`
                        break;
                    default:
                        out = `${out}/${level}`
                }
            }
        });
    return out;
}

/**
 * Routes handlers to express router.
 * @param router
 * @param options
 * 
 * modified by: Todd Bagley
 */
function expressroutes(router, options) {
    let method,
        mountpath,
        routes, 
        routePath,
        routesConsumes = {},
        routesMethod = {},
        routesProduces = {};

    if (options.errorname) {
        errorName = options.errorname;
    }

    routes = options.routes || [];
    options.docspath = utils.prefix(options.docspath || '/api-docs', '/');
    options.api.basePath = utils.prefix(options.api.basePath || '/', '/');
    mountpath = utils.unsuffix(options.api.basePath, '/');

    router.get(mountpath + options.docspath, function (req, res) {
        res.json(options.api);
    });

    routes.forEach(function (route) {
        makeExpressRoute(router, mountpath, route, options.api.securityDefinitions);
        method = route.method && route.method.toLowerCase();
        routePath = buildRoutePath(mountpath, route.path);

        routesMethod[routePath] = routesMethod[routePath] || [];
        routesMethod[routePath].push(method);

        routesConsumes[routePath] = routesConsumes[routePath] || {};
        routesConsumes[routePath][method] = routesConsumes[routePath][method] || [];
        if (route.consumes && route.consumes.length > 0) {
            routesConsumes[routePath][method].push(...route.consumes);
        }
        routesConsumes[routePath][method] = routesConsumes[routePath][method].filter((v, i, a) => a.indexOf(v) === i);
    
        routesProduces[routePath] = routesProduces[routePath] || {};
        routesProduces[routePath][method] = routesProduces[routePath][method] || [];
        if (route.produces && route.produces.length > 0) {
            routesProduces[routePath][method].push(...route.produces);
        }
        routesProduces[routePath][method] = routesProduces[routePath][method].filter((v, i, a) => a.indexOf(v) === i);
    });

    Object.keys(routesMethod)
        .forEach(routePath => {
            router.use(
                pathRegexp(routePath),
                appendSwaggerDefinitionsToReq(routePath, options.api),
                buildNotAllowedMiddleware(routesMethod[routePath]),
                validateContentTypeHeaderMiddleware(routesConsumes[routePath]),
                validateAcceptHeaderMiddleware(routesProduces[routePath], routesConsumes[routePath])
            );
        });
}


function authorizeFor(security, securityDefinitions) {

    return function authorize(req, res, next) {
        var errors = [];
        var securityDefinition;

        function passed(type, pass) {
            if (thing.isFunction(security[type].authorize)) {

                if (securityDefinitions) {
                    securityDefinition = securityDefinitions[type];
                }

                req.requiredScopes = security[type].scopes;

                security[type].authorize.call(securityDefinition, req, res, function (error) {
                    if (error) {
                        errors.push(error);
                        pass(false);
                        return;
                    }
                    pass(true);
                });

                return;
            }

            errors.push(new Error('Unauthorized.'));
            pass(false);
        }

        function done(success) {
            if (!success) {
                res.statusCode = 401;
                next(errors.shift());
                return;
            }
            next();
        }

        async.some(Object.keys(security), passed, done);
    };
}

module.exports = expressroutes;
