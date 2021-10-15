// Utility object:  Encode/Decode C-style binary primitives to/from octet arrays
function BufferPack() {
    // Module-level (private) letiables
    let el, bBE = false, m = this;

    // Raw byte arrays
    m._DeArray = function (a, p, l) {
        return [a.slice(p, p + l)];
    };
    m._EnArray = function (a, p, l, v) {
        for (let i = 0; i < l; a[p + i] = v[i] ? v[i] : 0, i++);
    };

    // ASCII characters
    m._DeChar = function (a, p) {
        return String.fromCharCode(a[p]);
    };
    m._EnChar = function (a, p, v) {
        a[p] = v.charCodeAt(0);
    };

    // Little-endian (un)signed N-byte integers
    m._DeInt = function (a, p) {
        let lsb = bBE ? (el.len - 1) : 0, nsb = bBE ? -1 : 1, stop = lsb + nsb * el.len, rv, i, f;
        for (rv = 0, i = lsb, f = 1; i != stop; rv += (a[p + i] * f), i += nsb, f *= 256);
        if (el.bSigned && (rv & Math.pow(2, el.len * 8 - 1))) {
            rv -= Math.pow(2, el.len * 8);
        }
        return rv;
    };
    m._EnInt = function (a, p, v) {
        let lsb = bBE ? (el.len - 1) : 0, nsb = bBE ? -1 : 1, stop = lsb + nsb * el.len, i;
        v = (v < el.min) ? el.min : (v > el.max) ? el.max : v;
        for (i = lsb; i != stop; a[p + i] = v & 0xff, i += nsb, v >>= 8);
    };

    // ASCII character strings
    m._DeString = function (a, p, l) {
        let rv = new Array(l);
        for (let i = 0; i < l; rv[i] = String.fromCharCode(a[p + i]), i++);
        return rv.join('');
    };
    m._EnString = function (a, p, l, v) {
        for (let t, i = 0; i < l; a[p + i] = t ? t : 0, i++) {
            t = v.charCodeAt(i);
        };
    };

    // ASCII character strings null terminated
    m._DeNullString = function (a, p, l, v) {
        let str = m._DeString(a, p, l, v);
        return str.substring(0, str.length - 1);
    };

    // Little-endian N-bit IEEE 754 floating point
    m._De754 = function (a, p) {
        let s, e, m, i, d, nBits, mLen, eLen, eBias, eMax;
        mLen = el.mLen, eLen = el.len * 8 - el.mLen - 1, eMax = (1 << eLen) - 1, eBias = eMax >> 1;

        i = bBE ? 0 : (el.len - 1); d = bBE ? 1 : -1; s = a[p + i]; i += d; nBits = -7;
        for (e = s & ((1 << (-nBits)) - 1), s >>= (-nBits), nBits += eLen; nBits > 0; e = e * 256 + a[p + i], i += d, nBits -= 8);
        for (m = e & ((1 << (-nBits)) - 1), e >>= (-nBits), nBits += mLen; nBits > 0; m = m * 256 + a[p + i], i += d, nBits -= 8);

        switch (e) {
            case 0:
                // Zero, or denormalized number
                e = 1 - eBias;
                break;
            case eMax:
                // NaN, or +/-Infinity
                return m ? NaN : ((s ? -1 : 1) * Infinity);
            default:
                // Normalized number
                m = m + Math.pow(2, mLen);
                e = e - eBias;
                break;
        }
        return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
    };
    m._En754 = function (a, p, v) {
        let s, e, m, i, d, c, mLen, eLen, eBias, eMax;
        mLen = el.mLen, eLen = el.len * 8 - el.mLen - 1, eMax = (1 << eLen) - 1, eBias = eMax >> 1;

        s = v < 0 ? 1 : 0;
        v = Math.abs(v);
        if (isNaN(v) || (v == Infinity)) {
            m = isNaN(v) ? 1 : 0;
            e = eMax;
        } else {
            e = Math.floor(Math.log(v) / Math.LN2);			// Calculate log2 of the value

            c = Math.pow(2, -e);
            if (v * c < 1) {
                e--; c *= 2;
            }

            // Round by adding 1/2 the significand's LSD
            if (e + eBias >= 1) {
                v += el.rt / c;                                           // Normalized:  mLen significand digits
            } else {
                v += el.rt * Math.pow(2, 1 - eBias);                        // Denormalized:  <= mLen significand digits
            }

            if (v * c >= 2) {
                e++; c /= 2;						// Rounding can increment the exponent
            }

            if (e + eBias >= eMax) {
                // Overflow
                m = 0;
                e = eMax;
            } else if (e + eBias >= 1) {
                // Normalized - term order matters, as Math.pow(2, 52-e) and v*Math.pow(2, 52) can overflow
                m = (v * c - 1) * Math.pow(2, mLen);
                e = e + eBias;
            } else {
                // Denormalized - also catches the '0' case, somewhat by chance
                m = v * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
                e = 0;
            }
        }

        for (i = bBE ? (el.len - 1) : 0, d = bBE ? -1 : 1; mLen >= 8; a[p + i] = m & 0xff, i += d, m /= 256, mLen -= 8);
        for (e = (e << mLen) | m, eLen += mLen; eLen > 0; a[p + i] = e & 0xff, i += d, e /= 256, eLen -= 8);
        a[p + i - d] |= s * 128;
    };

    // Class data
    m._sPattern = '(\\d+)?([AxcbBhHsSfdiIlL])(\\(([a-zA-Z0-9]+)\\))?';
    m._lenLut = {
        'A': 1, 'x': 1, 'c': 1, 'b': 1, 'B': 1, 'h': 2, 'H': 2, 's': 1,
        'S': 1, 'f': 4, 'd': 8, 'i': 4, 'I': 4, 'l': 4, 'L': 4
    };
    m._elLut = {
        'A': { en: m._EnArray, de: m._DeArray },
        's': { en: m._EnString, de: m._DeString },
        'S': { en: m._EnString, de: m._DeNullString },
        'c': { en: m._EnChar, de: m._DeChar },
        'b': { en: m._EnInt, de: m._DeInt, len: 1, bSigned: true, min: -Math.pow(2, 7), max: Math.pow(2, 7) - 1 },
        'B': { en: m._EnInt, de: m._DeInt, len: 1, bSigned: false, min: 0, max: Math.pow(2, 8) - 1 },
        'h': { en: m._EnInt, de: m._DeInt, len: 2, bSigned: true, min: -Math.pow(2, 15), max: Math.pow(2, 15) - 1 },
        'H': { en: m._EnInt, de: m._DeInt, len: 2, bSigned: false, min: 0, max: Math.pow(2, 16) - 1 },
        'i': { en: m._EnInt, de: m._DeInt, len: 4, bSigned: true, min: -Math.pow(2, 31), max: Math.pow(2, 31) - 1 },
        'I': { en: m._EnInt, de: m._DeInt, len: 4, bSigned: false, min: 0, max: Math.pow(2, 32) - 1 },
        'l': { en: m._EnInt, de: m._DeInt, len: 4, bSigned: true, min: -Math.pow(2, 31), max: Math.pow(2, 31) - 1 },
        'L': { en: m._EnInt, de: m._DeInt, len: 4, bSigned: false, min: 0, max: Math.pow(2, 32) - 1 },
        'f': { en: m._En754, de: m._De754, len: 4, mLen: 23, rt: Math.pow(2, -24) - Math.pow(2, -77) },
        'd': { en: m._En754, de: m._De754, len: 8, mLen: 52, rt: 0 }
    };

    // Unpack a series of n elements of size s from array a at offset p with fxn
    m._UnpackSeries = function (n, s, a, p) {
        let rv = [];
        for (let fxn = el.de, i = 0; i < n; rv.push(fxn(a, p + i * s)), i++);
        return rv;
    };

    // Pack a series of n elements of size s from array v at offset i to array a at offset p with fxn
    m._PackSeries = function (n, s, a, p, v, i) {
        for (let fxn = el.en, o = 0; o < n; fxn(a, p + o * s, v[i + o]), o++);
    };

    m._zip = function (keys, values) {
        let result = {};

        for (let i = 0; i < keys.length; i++) {
            result[keys[i]] = values[i];
        }

        return result;
    };

    // Unpack the octet array a, beginning at offset p, according to the fmt string
    m.unpack = function (fmt, a, p) {
        // Set the private bBE flag based on the format string - assume big-endianness
        bBE = (fmt.charAt(0) != '<');

        p = p ? p : 0;
        let re = new RegExp(this._sPattern, 'g');
        let m;
        let n;
        let s;
        let rk = [];
        let rv = [];

        m = re.exec(fmt);
        while (m) {
            n = ((m[1] == undefined) || (m[1] == '')) ? 1 : parseInt(m[1], 10);

            if (m[2] === 'S') { // Null term string support
                n = 0; // Need to deal with empty  null term strings
                while (a[p + n] !== 0) {
                    n++;
                }
                n++; // Add one for null byte
            }

            s = this._lenLut[m[2]];

            if ((p + n * s) > a.length) {
                return undefined;
            }

            switch (m[2]) {
                case 'A': case 's': case 'S':
                    rv.push(this._elLut[m[2]].de(a, p, n));
                    break;
                case 'c': case 'b': case 'B': case 'h': case 'H':
                case 'i': case 'I': case 'l': case 'L': case 'f': case 'd':
                    el = this._elLut[m[2]];
                    rv.push(this._UnpackSeries(n, s, a, p));
                    break;
            }

            rk.push(m[4]); // Push key on to array

            p += n * s;
            m = re.exec(fmt);
        }

        rv = Array.prototype.concat.apply([], rv);

        if (rk.indexOf(undefined) !== -1) {
            return rv;
        } else {
            return this._zip(rk, rv);
        }
    };

    // Pack the supplied values into the octet array a, beginning at offset p, according to the fmt string
    m.packTo = function (fmt, a, p, values) {
        // Set the private bBE flag based on the format string - assume big-endianness
        bBE = (fmt.charAt(0) != '<');

        let re = new RegExp(this._sPattern, 'g');
        let m;
        let n;
        let s;
        let i = 0;
        let j;

        m = re.exec(fmt);
        while (m) {
            n = ((m[1] == undefined) || (m[1] == '')) ? 1 : parseInt(m[1], 10);

            // Null term string support
            if (m[2] === 'S') {
                n = values[i].length + 1; // Add one for null byte
            }

            s = this._lenLut[m[2]];

            if ((p + n * s) > a.length) {
                return false;
            }

            switch (m[2]) {
                case 'A': case 's': case 'S':
                    if ((i + 1) > values.length) { return false; }
                    this._elLut[m[2]].en(a, p, n, values[i]);
                    i += 1;
                    break;
                case 'c': case 'b': case 'B': case 'h': case 'H':
                case 'i': case 'I': case 'l': case 'L': case 'f': case 'd':
                    el = this._elLut[m[2]];
                    if ((i + n) > values.length) { return false; }
                    this._PackSeries(n, s, a, p, values, i);
                    i += n;
                    break;
                case 'x':
                    for (j = 0; j < n; j++) { a[p + j] = 0; }
                    break;
            }
            p += n * s;
            m = re.exec(fmt);
        }

        return a;
    };

    // Pack the supplied values into a new octet array, according to the fmt string
    m.pack = function (fmt, values) {
        return this.packTo(fmt, Buffer.alloc(this.calcLength(fmt, values)), 0, values);
    };

    // Determine the number of bytes represented by the format string
    m.calcLength = function (format, values) {
        let re = new RegExp(this._sPattern, 'g'), m, sum = 0, i = 0;

        m = re.exec(format);
        while (m) {
            let n = (((m[1] == undefined) || (m[1] == '')) ? 1 : parseInt(m[1], 10)) * this._lenLut[m[2]];

            if (m[2] === 'S') {
                n = values[i].length + 1; // Add one for null byte
            }

            sum += n;
            i++;
            m = re.exec(format);
        }
        return sum;
    };
};

const bufferpackFunc = new BufferPack();
export default bufferpackFunc;