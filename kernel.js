(function () {
  /*!

    Copyright (C) 2011 Chad Weider

    This software is provided 'as-is', without any express or implied
    warranty. In no event will the authors be held liable for any damages
    arising from the use of this software.

    Permission is granted to anyone to use this software for any purpose,
    including commercial applications, and to alter it and redistribute it
    freely, subject to the following restrictions:

    1. The origin of this software must not be misrepresented; you must not
       claim that you wrote the original software. If you use this software in
       a product, an acknowledgment in the product documentation would be
       appreciated but is not required.
    2. Altered source versions must be plainly marked as such, and must not be
       misrepresented as being the original software.
    3. This notice may not be removed or altered from any source distribution.

  */

  /* Storage */
  var main = null; // Reference to main module in `modules`.
  var modules = {}; // Repository of module objects build from `definitions`.
  var definitions = {}; // Functions that construct `modules`.
  var loadingModules = {}; // Locks for detecting circular dependencies.
  var definitionWaiters = {}; // Locks for clearing duplicate requires.
  var fetchRequests = []; // Queue of pending requests.
  var currentRequests = 0; // Synchronization for parallel requests.
  var maximumRequests = 1;

  var syncLock = undefined;
  var globalKeyPath = undefined;

  var rootURI = undefined;
  var libraryURI = undefined;

  var JSONP_TIMEOUT = 60 * 1000;

  var CircularDependencyError = function () {Error.apply(this, arguments)};
  CircularDependencyError.prototype = new Error();

  /* Utility */
  function hasOwnProperty(object, key) {
    // Object-independent because an object may define `hasOwnProperty`.
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  // See RFC 2396 Appendix B
  var URI_EXPRESSION =
      /^(([^:\/?#]+):)?(\/\/([^\/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;
  function parseURI(uri) {
    var match = uri.match(URI_EXPRESSION);
    var location = match && {
      scheme: match[2],
      host: match[4],
      path: match[5],
      query: match[7],
      fragment: match[9]
    };
    return location;
  }

  function joinURI(location) {
    var uri = "";
    if (location.scheme)
      uri += location.scheme + ':';
    if (location.host)
      uri += "//" + location.host
    if (location.path)
      uri += location.path
    if (location.query)
      uri += "?" + location.query
    if (uri.fragment)
      uri += "#" + location.fragment

    return uri;
  }

  function isSameDomain(uri) {
    var host_uri =
      (typeof location == "undefined") ? {} : parseURI(location.toString());
    var uri = parseURI(uri);

    return (uri.scheme === host_uri.scheme) && (uri.host === host_uri.host);
  }

  function mirroredURIForURI(uri) {
    var host_uri =
      (typeof location == "undefined") ? {} : parseURI(location.toString());
    var uri = parseURI(uri);

    uri.scheme = host_uri.scheme;
    uri.host = host_uri.host;
    return joinURI(uri);
  }

  function normalizePath(path) {
    var pathComponents1 = path.split('/');
    var pathComponents2 = [];

    var component;
    for (var i = 0, ii = pathComponents1.length; i < ii; i++) {
      component = pathComponents1[i];
      switch (component) {
        case '':
          if (i == ii - 1) {
            pathComponents2.push(component);
            break;
          }
        case '.':
          if (i == 0) {
            pathComponents2.push(component);
          }
          break;
        case '..':
          if (pathComponents2.length > 1
            || (pathComponents2.length == 1
              && pathComponents2[0] != ''
              && pathComponents2[0] != '.')) {
            pathComponents2.pop();
            break;
          }
        default:
          pathComponents2.push(component);
      }
    }

    return pathComponents2.join('/');
  }

  function fullyQualifyPath(path, basePath) {
    var fullyQualifiedPath = path;
    if (path.charAt(0) == '.'
      && (path.charAt(1) == '/'
        || (path.charAt(1) == '.' && path.charAt(2) == '/'))) {
      if (!basePath) {
        basePath = '/';
      } else if (basePath.charAt(basePath.length-1) != '/') {
        basePath += '/';
      }
      fullyQualifiedPath = basePath + path;
    }
    return fullyQualifiedPath;
  }

  function setRootURI(URI) {
    if (!URI) {
      throw new Error("Argument Error: invalid root URI.");
    }
    rootURI = (URI.charAt(URI.length-1) == '/' ? URI.slice(0,-1) : URI);
  }

  function setLibraryURI(URI) {
    libraryURI = (URI.charAt(URI.length-1) == '/' ? URI : URI + '/');
  }

  function URIForModulePath(path) {
    var components = path.split('/');
    for (var i = 0, ii = components.length; i < ii; i++) {
      components[i] = encodeURIComponent(components[i]);
    }
    path = components.join('/')

    if (path.charAt(0) == '/') {
      if (!rootURI) {
        throw new Error("Attempt to retrieve the root module "
          + "\""+ path + "\" but no root URI is defined.");
      }
      return rootURI + path;
    } else {
      if (!libraryURI) {
        throw new Error("Attempt to retrieve the library module "
          + "\""+ path + "\" but no libary URI is defined.");
      }
      return libraryURI + path;
    }
  }

  /* Remote */
  function setRequestMaximum (value) {
    value == parseInt(value);
    if (value > 0) {
      maximumRequests = value;
      checkScheduledfetchDefines();
    } else {
      throw new Error("Argument Error: value must be a positive integer.")
    }
  }

  function setGlobalKeyPath (value) {
    globalKeyPath = value;
  }

  var XMLHttpFactories = [
    function () {return new XMLHttpRequest()},
    function () {return new ActiveXObject("Msxml2.XMLHTTP")},
    function () {return new ActiveXObject("Msxml3.XMLHTTP")},
    function () {return new ActiveXObject("Microsoft.XMLHTTP")}
  ];

  function createXMLHTTPObject() {
    var xmlhttp = false;
    for (var i = 0, ii = XMLHttpFactories.length; i < ii; i++) {
      try {
        xmlhttp = XMLHttpFactories[i]();
      } catch (error) {
        continue;
      }
      break;
    }
    return xmlhttp;
  }

  function getXHR(uri, async, callback, request) {
    var request = request || createXMLHTTPObject();
    if (!request) {
      throw new Error("Error making remote request.")
    }

    function onComplete(request) {
      // Build module constructor.
      if (request.status == 200) {
        callback(undefined, request.responseText);
      } else {
        callback(true, undefined);
      }
    }

    request.open('GET', uri, !!(async));
    if (async) {
      request.onreadystatechange = function (event) {
        if (request.readyState == 4) {
          onComplete(request);
        }
      };
      request.send(null);
    } else {
      request.send(null);
      onComplete(request);
    }
  }

  function getXDR(uri, callback) {
    var xdr = new XDomainRequest();
    xdr.open('GET', uri);
    xdr.error(function () {
      callback(true, undefined);
    });
    xdr.onload(function () {
      callback(undefined, request.responseText);
    });
    xdr.send();
  }

  function fetchDefineXHR(path, async) {
    // If cross domain and request doesn't support such requests, go straight
    // to mirrioring.

    var _globalKeyPath = globalKeyPath;

    var callback = function (error, text) {
      if (error) {
        define(path, null);
      } else {
        if (_globalKeyPath) {
          var code = new Function(text);
          code();
        } else {
          var definition = new Function(
              'return function (require, exports, module) {\n'
                + text + '};\n')();
          define(path, definition);
        }
      }
    }

    var uri = URIForModulePath(path);
    if (_globalKeyPath) {
      uri += '?callback=' + encodeURIComponent(globalKeyPath + '.define');
    }
    if (isSameDomain(uri)) {
      getXHR(uri, async, callback);
    } else {
      var request = createXMLHTTPObject();
      if (request && request.withCredentials !== undefined) {
        getXHR(uri, async, callback, request);
      } else if (async && (typeof XDomainRequest != "undefined")) {
        getXDR(uri, callback);
      } else {
        getXHR(mirroredURIForURI(uri), async, callback);
      }
    }
  }

  function fetchDefineJSONP(path) {
    var head = document.head
      || document.getElementsByTagName('head')[0]
      || document.documentElement;
    var script = document.createElement('script');
    script.defer = "defer";
    script.async = "async";
    script.type = "application/javascript";
    script.src = URIForModulePath(path)
      + '?callback=' + encodeURIComponent(globalKeyPath + '.define');

    // Handle failure of JSONP request.
    if (JSONP_TIMEOUT < Infinity) {
      var timeoutId = setTimeout(function () {
        timeoutId = undefined;
        define(path, null);
      }, JSONP_TIMEOUT);
      definitionWaiters[path].unshift(function () {
        timeoutId === undefined && clearTimeout(timeoutId);
      });
    }

    head.insertBefore(script, head.firstChild);
  }

  /* Modules */
  function fetchModule(path, continuation) {
    if (hasOwnProperty(definitionWaiters, path)) {
      definitionWaiters[path].push(continuation);
    } else {
      definitionWaiters[path] = [continuation];
      schedulefetchDefine(path);
    }
  }

  function schedulefetchDefine(path) {
    fetchRequests.push(path);
    checkScheduledfetchDefines();
  }

  function checkScheduledfetchDefines() {
    if (fetchRequests.length > 0 && currentRequests < maximumRequests) {
      var fetchRequest = fetchRequests.pop();
      currentRequests++;
      definitionWaiters[fetchRequest].unshift(function () {
        currentRequests--;
        checkScheduledfetchDefines();
      });
      if (globalKeyPath
        && ((typeof document != undefined)
          && document.readyState && document.readyState != 'loading')) {
        fetchDefineJSONP(fetchRequest);
      } else {
        fetchDefineXHR(fetchRequest, true);
      }
    }
  }

  function fetchModuleSync(path, continuation) {
    fetchDefineXHR(path, false);
    continuation();
  }

  function moduleIsLoaded(path) {
    return hasOwnProperty(modules, path);
  }

  function loadModule(path, continuation) {
    // If it's a function then it hasn't been exported yet. Run function and
    //  then replace with exports result.
    if (!moduleIsLoaded(path)) {
      if (hasOwnProperty(loadingModules, path)) {
        var error =
            new CircularDependencyError("Encountered circular dependency.")
        continuation(error, undefined);
      } else if (!moduleIsDefined(path)) {
        var error = new Error("Attempt to load undefined module.")
        continuation(error, undefined);
      } else if (definitions[path] === null) {
        continuation(undefined, null);
      } else {
        var definition = definitions[path];
        var _module = {id: path, exports: {}};
        var _require = requireRelativeTo(path.replace(/[^\/]+$/,''));
        if (!main) {
          main = _module;
        }
        try {
          loadingModules[path] = true;
          definition(_require, _module.exports, _module);
          modules[path] = _module;
          delete loadingModules[path];
          continuation(undefined, _module);
        } catch (error) {
          delete loadingModules[path];
          continuation(error, undefined);
        }
      }
    } else {
      var module = modules[path];
      continuation(undefined, module);
    }
  }

  function _moduleAtPath(path, fetchFunc, continuation) {
    var suffixes = ['', '.js', '/index.js'];
    if (path.charAt(path.length - 1) == '/') {
      suffixes = ['index.js'];
    }

    var i = 0, ii = suffixes.length;
    var _find = function (i) {
      if (i < ii) {
        var path_ = path + suffixes[i];
        var after = function () {
          loadModule(path_, function (error, module) {
            if (error) {
              continuation(error, module);
            } else if (module === null) {
              _find(i + 1);
            } else {
              continuation(undefined, module);
            }
          });
        }

        if (!moduleIsDefined(path_)) {
          fetchFunc(path_, after);
        } else {
          after();
        }

      } else {
        continuation(undefined, null);
      }
    };
    _find(0);
  }

  function moduleAtPath(path, continuation) {
    var wrappedContinuation = function (error, module) {
      if (error) {
        if (error instanceof CircularDependencyError) {
          // Are the conditions for deadlock satisfied or not?
          // TODO: This and define's satisfy should use a common deferral
          // mechanism.
          setTimeout(function () {moduleAtPath(path, continuation)}, 0);
        } else {
          continuation(null);
        }
      } else {
        continuation(module);
      }
    };
    _moduleAtPath(path, fetchModule, wrappedContinuation);
  }

  function moduleAtPathSync(path) {
    var module;
    var oldSyncLock = syncLock;
    syncLock = true;
    try {
      _moduleAtPath(path, fetchModuleSync, function (error, _module) {
        if (error) {
          throw error;
        } else {
          module = _module
        }
      });
    } finally {
      syncLock = oldSyncLock;
    }
    return module;
  }

  /* Definition */
  function moduleIsDefined(path) {
    return hasOwnProperty(definitions, path);
  }

  function defineModule(path, module) {
    if (typeof path != 'string'
      || !((module instanceof Function) || module === null)) {
      throw new Error(
          "Argument error: define must be given a (string, function) pair.");
    }

    if (moduleIsDefined(path)) {
      // Drop import silently
    } else {
      definitions[path] = module;
    }
  }

  function defineModules(moduleMap) {
    if (typeof moduleMap != 'object') {
      throw new Error("Argument error: define must be given a object.");
    }
    for (var path in moduleMap) {
      if (hasOwnProperty(moduleMap, path)) {
        defineModule(path, moduleMap[path]);
      }
    }
  }

  function define(fullyQualifiedPathOrModuleMap, module) {
    var moduleMap;
    if (arguments.length == 1) {
      moduleMap = fullyQualifiedPathOrModuleMap;
      defineModules(moduleMap);
    } else if (arguments.length == 2) {
      var path = fullyQualifiedPathOrModuleMap;
      defineModule(fullyQualifiedPathOrModuleMap, module);
      moduleMap = {};
      moduleMap[path] = module;
    } else {
      throw new Error("Argument error: expected 1 or 2 got "
          + arguments.length + ".");
    }

    // With all modules installed satisfy those conditions for all waiters.
    var continuations = [];
    for (var path in moduleMap) {
      if (hasOwnProperty(moduleMap, path)
        && hasOwnProperty(definitionWaiters, path)) {
        continuations.push.apply(continuations, definitionWaiters[path]);
        delete definitionWaiters[path];
      }
    }
    function satisfy() {
      // Let exceptions happen, but don't allow them to break notification.
      try {
        while (continuations.length) {
          var continuation = continuations.shift();
          continuation();
        }
      } finally {
        continuations.length && setTimeout(satisfy, 0);
      }
    }

    if (syncLock) {
      // Only asynchronous operations will wait on this condition so schedule
      // and don't interfere with the synchronous operation in progress.
      setTimeout(continuations, 0);
    } else {
      satisfy(continuations);
    }
  }

  /* Require */
  function requireBase(path, continuation) {
    if (continuation === undefined) {
      var module = moduleAtPathSync(path);
      if (!module) {
        throw new Error("The module at \"" + path + "\" does not exist.");
      }
      return module.exports;
    } else {
      if (!(continuation instanceof Function)) {
        throw new Error("Argument Error: continuation must be a function.");
      }

      moduleAtPath(path, function (module) {
        continuation(module && module.exports);
      });
    }
  }

  function requireRelative(basePath, qualifiedPath, continuation) {
    qualifiedPath = qualifiedPath.toString();
    var path = normalizePath(fullyQualifyPath(qualifiedPath, basePath));
    return requireBase(path, continuation);
  }

  function requireRelativeN(basePath, qualifiedPaths, continuation) {
    if (!(continuation instanceof Function)) {
      throw new Error("Final argument must be a continuation.");
    } else {
      // Copy and validate parameters
      var _qualifiedPaths = [];
      for (var i = 0, ii = qualifiedPaths.length; i < ii; i++) {
        _qualifiedPaths[i] = qualifiedPaths[i].toString();
      }
      var results = [];
      function _require(result) {
        results.push(result);
        if (qualifiedPaths.length > 0) {
          requireRelative(basePath, qualifiedPaths.shift(), _require);
        } else {
          continuation.apply(this, results);
        }
      }
      for (var i = 0, ii = qualifiedPaths.length; i < ii; i++) {
        requireRelative(basePath, _qualifiedPaths[i], _require);
      }
    }
  }

  var requireRelativeTo = function (basePath) {
    function require(qualifiedPath, continuation) {
      if (arguments.length > 2) {
        var qualifiedPaths = Array.prototype.slice.call(arguments, 0, -1);
        var continuation = arguments[arguments.length-1];
        return requireRelativeN(basePath, qualifiedPaths, continuation);
      } else {
        return requireRelative(basePath, qualifiedPath, continuation);
      }
    }
    require.main = main;

    return require;
  }

  var rootRequire = requireRelativeTo('/');
  rootRequire._modules = modules;
  rootRequire._definitions = definitions;
  rootRequire.define = define;
  rootRequire.setRequestMaximum = setRequestMaximum;
  rootRequire.setGlobalKeyPath = setGlobalKeyPath;
  rootRequire.setRootURI = setRootURI;
  rootRequire.setLibraryURI = setLibraryURI;
  return rootRequire;
})();
