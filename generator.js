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

// Funkce na extrakci barvy pro podobnost
function extractColor(vidPath) {
    try {
        // Odstraněn parametr -ss 0, který dělá problémy u syrových WebM z prohlížeče
        const buffer = execSync(`ffmpeg -i "${vidPath}" -vframes 1 -vf scale=1:1 -f image2pipe -vcodec rawvideo -pix_fmt rgb24 -`, { stdio: ['pipe', 'pipe', 'ignore'] });
        if (buffer.length >= 3) {
            return { r: buffer[0], g: buffer[1], b: buffer[2] };
        }
        return null;
    } catch (e) { 
        return null; 
    }
}

function getDirSizeMB(dir) {
    let size = 0;
    fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (fs.statSync(p).isFile() && f.endsWith('.webm')) size += fs.statSync(p).size;
    });
    return size / (1024 * 1024);
}

// 1. DATABÁZE
let db = [];
if (fs.existsSync(DB_PATH)) {
    try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) { }
}

const diskFiles = fs.readdirSync(MEM_DIR).filter(f => f.startsWith('mem_') && f.endsWith('.webm'));
const existingNames = new Set(db.map(m => m.filename));

diskFiles.forEach(f => {
    if (!existingNames.has(f)) {
        db.push({
            filename: f,
            timestamp: parseInt(f.split('_')[1]) || Date.now(),
            stats: { volume: 50, color: '#888888', motion: 50, brightness: 50 }
        });
    }
});
db.sort((a, b) => a.timestamp - b.timestamp);

// Doplnění barev
db.forEach(m => {
    if (!m.deleted && (!m.stats || !m.stats.colorRGB)) {
        const p = path.join(MEM_DIR, m.filename);
        if (fs.existsSync(p)) {
            const c = extractColor(p);
            if (c) m.stats = { ...m.stats, color: `rgb(${c.r},${c.g},${c.b})`, colorRGB: c, brightness: Math.round((c.r + c.g + c.b) / 3) };
        }
    }
});

// Kontrola limitu kapacity repozitare (1 000 MB)
const LIMIT_MB = 1000;
let currentSize = getDirSizeMB(MEM_DIR);

if (currentSize > LIMIT_MB) {
    console.log(`[!] Velikost paměti (${currentSize.toFixed(1)}MB) přesáhla limit ${LIMIT_MB}MB. Promazávám gradientním algoritmem...`);
    const TARGET_MB = LIMIT_MB * 0.95; // Promazat pod 950 MB

    while (currentSize > TARGET_MB) {
        let undeleted = db.filter(m => !m.deleted);
        if (undeleted.length < 20) break; // Nechat aspoň 20

        let bestI = -1;
        let minScore = Infinity;

        for (let i = 0; i < undeleted.length - 1; i++) {
            const m1 = undeleted[i], m2 = undeleted[i + 1];

            let colorDiff = 0;
            // Pokud obě videa mají platnou barvu, porovnáme je
            if (m1.stats && m1.stats.colorRGB && m2.stats && m2.stats.colorRGB && m1.stats.colorRGB.r !== undefined) {
                const dr = m1.stats.colorRGB.r - m2.stats.colorRGB.r;
                const dg = m1.stats.colorRGB.g - m2.stats.colorRGB.g;
                const db_ = m1.stats.colorRGB.b - m2.stats.colorRGB.b;
                colorDiff = Math.sqrt(dr * dr + dg * dg + db_ * db_);
            } else {
                // ZÁCHRANNÁ BRZDA: Pokud FFMPEG u videa selhal, penalizujeme ho, 
                // ale nezastavíme proces! Rozhodne se pouze podle času.
                colorDiff = 50; 
            }

            const dt = Math.abs(m2.timestamp - m1.timestamp) / 1000;
            const score = colorDiff + (dt * 0.1);

            if (score < minScore) {
                minScore = score;
                bestI = i; // Smažeme staršího z dvojice (m1)
            }
        }

        if (bestI !== -1) {
            const target = undeleted[bestI];
            target.deleted = true;
            target.reason = "smazana vzpominka z tohoto data";
            const vp = path.join(MEM_DIR, target.filename);
            if (fs.existsSync(vp)) {
                currentSize -= fs.statSync(vp).size / (1024 * 1024);
                fs.unlinkSync(vp);
                console.log(` -> Smazáno: ${target.filename} (skóre duplicity: ${minScore.toFixed(1)})`);
            }
        } else {
            break;
        }
    }
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// 2. NÁHLEDY (Generuje se každý 5. snímek)
console.log("Generuji náhledy...");
db.forEach((mem, index) => {
    if (mem.deleted) return;
    if (index % 5 === 0) {
        const thumbPath = path.join(THUMB_DIR, `thumb_${index}.jpg`);
        const vidPath = path.join(MEM_DIR, mem.filename);
        if (!fs.existsSync(thumbPath)) {
            try {
                // Rychlý náhled (scale 160px na šířku)
                execSync(`ffmpeg -ss 0.0 -i "${vidPath}" -vframes 1 -vf scale=160:-1 -q:v 10 "${thumbPath}" -y`, { stdio: 'ignore' });
            } catch (e) { }
        }
    }
});

// 3. CHUNKY (VP9 + AUDIO)
const totalChunks = Math.floor(db.length / CHUNK_SIZE);
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
            let lastValidIPath = null;
            let firstValidIPath = null;

            // Fáze 1: Vytěžení snímků z existujících videí
            slice.forEach((mem, idx) => {
                const iPath = path.join(tempDir, `img_${String(idx).padStart(4, '0')}.jpg`);
                if (!mem.deleted) {
                    const vPath = path.join(MEM_DIR, mem.filename);
                    try {
                        execSync(`ffmpeg -ss 0.0 -i "${vPath}" -vframes 1 -q:v 2 "${iPath}" -y`, { stdio: 'ignore' });
                        if (fs.existsSync(iPath)) {
                            lastValidIPath = iPath;
                            if (!firstValidIPath) firstValidIPath = iPath;
                            count++;
                        }
                    } catch (e) { }
                }
            });

            // Fáze 2: Doplnění mezer u smazaných vzpomínek aspoň kopiemi okolních (aby nevznikl skok v časové ose chunků)
            slice.forEach((mem, idx) => {
                const iPath = path.join(tempDir, `img_${String(idx).padStart(4, '0')}.jpg`);
                if (!fs.existsSync(iPath)) {
                    if (lastValidIPath && fs.existsSync(lastValidIPath)) {
                        fs.copyFileSync(lastValidIPath, iPath);
                        count++;
                    } else if (firstValidIPath && fs.existsSync(firstValidIPath)) {
                        fs.copyFileSync(firstValidIPath, iPath);
                        count++;
                    }
                } else {
                    lastValidIPath = iPath; // updatuje referenci plynule vpřed
                }
            });

            if (count > 0) {
                // VP9 + OPUS AUDIO (Tichá stopa generated by lavfi, aby prohlížeč nepanikařil)
                // Nebo pokud chceš původní audio, je to složitější u fotek.
                // Zde generujeme "němou" audio stopu, aby video mělo audio track a neblblo.
                execSync(`ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -framerate 30 -i ${tempDir}/img_%04d.jpg -c:v libvpx-vp9 -b:v 2000k -c:a libopus -shortest -vf "setpts=N/30/TB,format=yuv420p" -g 30 -row-mt 1 "${chunkPath}"`);
                console.log("Chunk hotov.");
            }
        } catch (e) { console.error(e.message); }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { }
    }
}
