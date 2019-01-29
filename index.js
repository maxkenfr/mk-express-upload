const fs = require('fs-extra');
const multer = require('multer');
const path = require('path');
const Boom = require('boom');
const mime = require('mime-types');
const bytes = require('bytes');
const md5 = require('md5');
const LruCache = require('lru-cache');
const STORAGE_CACHE_LRU = new LruCache(100);

let tmpDir = './tmp';
fs.emptydirSync(tmpDir);

let STORAGE_CACHE = {
    get: (key) => STORAGE_CACHE_LRU.get(key),
    has: (key) => STORAGE_CACHE_LRU.has(key),
    set: (key, data) => STORAGE_CACHE_LRU.set(key, data),
    del: (key) => STORAGE_CACHE_LRU.del(key),
    keys: () => STORAGE_CACHE_LRU.keys()
};

const multerStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, tmpDir)
    },
    filename: function (req, file, cb) {
        let fileName = md5(file.originalname + file.mimetype + new Date);
        fileName = `${fileName}.${file.mimetype.match(/\/(\w*){1}/is)[1]}`;
        cb(null, fileName);
    }
});

function setUploadDir(dir) {
    tmpDir = dir;
    fs.emptydirSync(tmpDir);
    return true;
}

function setStorageCache(storageCache) {
    ['get', 'has', 'del', 'set', 'keys'].forEach(key=>{
        if (!storageCache[key]) throw `You must declare a "${key}" function`;
        if (typeof storageCache[key] !== 'function') throw `"${key}" must be a function`;
    });
    return true;
}

const storage = function (filename) {
    let file = STORAGE_CACHE.get(path.basename(filename));
    if(!file) return false;
    if(!fs.existsSync(file.path)){
        STORAGE_CACHE.del(file.filename);
        throw Boom.badData('File entry exists in storage cache but is unable to reach in filesystem', {errors: {filename}});
    }
    return enhanceFile(file);
};

function enhanceFile(file) {
    return {
        ...file,
        delete : ()=>{
            STORAGE_CACHE.del(file.filename);
            return fs.remove(file.path)
        },
        moveTo : (to, options = {})=>{
            STORAGE_CACHE.del(file.filename);
            return fs.move(file.path, to, options)
        },
        buffer : ()=>{
            return fs.readFile(file.path);
        },
        bufferSync : ()=>{
            return fs.readFileSync(file.path);
        }
    }
}

function uploadMiddleware(opts){
    let options = {
        allowed : {},
        ...opts
    };

    Object.keys(options.allowed).forEach(type=>{
        if (typeof options.allowed[type] !== 'string') throw `Allowed max size must be a string for type "${type}"`;
    });

    function fileFilter(req, file, callback){
        try {
            let requestSize = Number(req.headers['content-length'] || '0');
            let type = mime.extension(file.mimetype);
            let maxFileSizeStr = options.allowed[type];
            if(!maxFileSizeStr) throw Boom.unsupportedMediaType('', {errors: {allowedTypes : Object.keys(options.allowed)}});
            let maxFileSize = bytes(maxFileSizeStr);
            if(requestSize > maxFileSize) throw Boom.entityTooLarge('', {errors: {maxFileSize, maxFileSizeStr}});
            callback(null, true);
        }
        catch (e) {
            callback(e);
        }
    }

    let upload = multer({
        storage : multerStorage,
        fileFilter
    }).single('file');

    return function (req, res, next) {
        upload(req, res, async function (err) {
            if (err) next(err);
            else {
                req.file.type = mime.extension(req.file.mimetype);
                req.file.sizeStr = bytes(req.file.size);
                STORAGE_CACHE.set(req.file.filename, req.file);
                req.file = enhanceFile(req.file);
                next();
            }
        })
    }
}

module.exports = {
    setUploadDir,
    setStorageCache,
    uploadMiddleware,
    STORAGE_CACHE,
    storage
};