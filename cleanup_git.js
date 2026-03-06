const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

console.log("=========================================");
console.log("  BERTIK - ČIŠTĚNÍ GIT HISTORIE");
console.log("=========================================\n");

try {
    const dbPath = 'memories/database.json';
    if (!fs.existsSync(dbPath)) {
        console.log("Chyba: Databáze nebyla nalezena. Ujistěte se, že spouštíte skript ve složce bertik.");
        process.exit(1);
    }

    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const deletedFiles = db.filter(m => m.deleted).map(m => `memories/${m.filename}`);

    if (deletedFiles.length === 0) {
        console.log("Skvělé! V databázi nejsou žádné smazané vzpomínky k odstranění z Git historie.");
        process.exit(0);
    }

    console.log(`Nalezeno ${deletedFiles.length} smazaných souborů označených k trvalému vyčištění z Git historie.`);

    // Vytvoření dočasného .sh skriptu s přesnými příkazy na promazání cache
    const rmShPath = path.join(__dirname, 'rm_deleted.sh').replace(/\\/g, '/');
    let rmScript = deletedFiles.map(f => `git rm --cached --ignore-unmatch "${f}" > /dev/null 2>&1`).join('\n');
    fs.writeFileSync('rm_deleted.sh', rmScript);

    console.log("Spouštím git filter-branch. NEZAVÍREJTE TOTO OKNO! PROCES MŮŽE TRVAT NĚKOLIK MINUT...");

    // Použití absolutní cesty pro vložení do skriptu, MinGW git na Windows přežvýká C:/...
    const filterCmd = `git filter-branch --force --index-filter "sh \\"${rmShPath}\\"" --prune-empty --tag-name-filter cat -- --all`;

    execSync(filterCmd, { stdio: 'inherit' });

    console.log("\nOptimalizuji repozitář a mažu dočasné GIT reference...");
    try { execSync('git for-each-ref --format="%(refname)" refs/original/ | xargs -r -n 1 git update-ref -d', { stdio: 'ignore' }); } catch (e) { }
    try { execSync('git reflog expire --expire=now --all', { stdio: 'ignore' }); } catch (e) { }
    try { execSync('git gc --prune=now --aggressive', { stdio: 'ignore' }); } catch (e) { }

    // Úklid dočasného souboru
    try { fs.unlinkSync('rm_deleted.sh'); } catch (e) { }

    console.log("\n=========================================");
    console.log("   ÚSPĚŠNĚ DOKONČENO!");
    console.log("Historie Gitu byla úspěšně zbavena smazaných videí.");
    console.log("\nNYNÍ DŮLEŽITÝ KROK: Otevři si příkazový řádek a proveď FORCE PUSH!");
    console.log("Spusť přesně tento příkaz:");
    console.log(" -->   git push origin main --force   <--");
    console.log("=========================================\n");

} catch (err) {
    console.error("\n[!] Došlo k neočekávané chybě: ", err.message);
    try { fs.unlinkSync('rm_deleted.sh'); } catch (e) { }
}
