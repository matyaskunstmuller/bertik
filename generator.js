const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const MEM_DIR = 'memories';
const CHUNK_DIR = 'memories/chunks';
const THUMB_DIR = 'memories/thumbs';
const DB_PATH = 'memories/database.json';
const CHUNK_SIZE = 300;

if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// 1. DATABÁZE (Merge existing with disk to preserve indices and identify deleted)
console.log("Analyzuji paměti...");
let db = [];
if (fs.existsSync(DB_PATH)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) { }
}

const diskFiles = new Set(fs.readdirSync(MEM_DIR).filter(f => f.startsWith('mem_') && f.endsWith('.webm')));

// Nastav smazané
db.forEach(entry => {
    if (!diskFiles.has(entry.filename)) {
        entry.deleted = true;
    }
});

// Přidej nové
const existingNames = new Set(db.map(e => e.filename));
diskFiles.forEach(f => {
    if (!existingNames.has(f)) {
        db.push({
            filename: f,
            timestamp: parseInt(f.split('_')[1]) || Date.now(),
            stats: { volume: 50, color: '#888888', motion: 50, brightness: 50 },
            deleted: false
        });
    }
});
db.sort((a, b) => a.timestamp - b.timestamp);
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));


// 2. NÁHLEDY (Generuje se každý 5. snímek, včetně černých zástupců pro smazané)
console.log("Generuji náhledy...");
db.forEach((mem, index) => {
    if (index % 5 === 0) {
        const thumbPath = path.join(THUMB_DIR, `thumb_${index}.jpg`);
        if (!fs.existsSync(thumbPath)) {
            try {
                if (mem.deleted) {
                    execSync(`ffmpeg -f lavfi -i color=c=black:s=160x120 -vframes 1 "${thumbPath}" -y`, { stdio: 'ignore' });
                } else {
                    const vidPath = path.join(MEM_DIR, mem.filename);
                    execSync(`ffmpeg -ss 0.0 -i "${vidPath}" -vframes 1 -vf scale=160:-1 -q:v 10 "${thumbPath}" -y`, { stdio: 'ignore' });
                }
            } catch (e) { }
        }
    }
});

// 3. CHUNKY (VP9 BEZ ZVUKU)
// Bez zvuku proto, že generování tiché Opus stopy přes lavfi vytváří v Chrome "Error parsing Opus packet header" 
// a Chrome pak časosběr po prvním framu okamžitě ukončí (spustí 'onended').
const totalChunks = Math.ceil(db.length / CHUNK_SIZE);
for (let i = 0; i < totalChunks; i++) {
    const chunkName = `chunk_${i}.webm`;
    const chunkPath = path.join(CHUNK_DIR, chunkName);

    if (!fs.existsSync(chunkPath)) {
        console.log(`Generuji ${chunkName}...`);
        const slice = db.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const tempDir = `temp_img_${i}`;

        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        fs.mkdirSync(tempDir);

        try {
            let count = 0;
            slice.forEach((mem, idx) => {
                const iPath = path.join(tempDir, `img_${String(idx).padStart(4, '0')}.jpg`);
                try {
                    if (mem.deleted) {
                        execSync(`ffmpeg -f lavfi -i color=c=black:s=640x480 -vframes 1 "${iPath}" -y`, { stdio: 'ignore' });
                    } else {
                        const vPath = path.join(MEM_DIR, mem.filename);
                        execSync(`ffmpeg -ss 0.0 -i "${vPath}" -vframes 1 -q:v 2 "${iPath}" -y`, { stdio: 'ignore' });
                    }
                    count++;
                } catch (e) { }
            });

            if (count > 0) {
                // Přegenerujeme pouze video s -an (bez audia) namísto poškozene Opus stopy.
                execSync(`ffmpeg -framerate 30 -i ${tempDir}/img_%04d.jpg -c:v libvpx-vp9 -b:v 2000k -an -shortest -vf "setpts=N/30/TB,format=yuv420p" -g 30 -row-mt 1 "${chunkPath}"`);
                console.log("Chunk hotov.");
            }
        } catch (e) { console.error(e.message); }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { }
    }
}
