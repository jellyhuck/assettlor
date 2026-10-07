import path from 'path';
import fs from 'fs';
import { initDatabase, getDatabase, queryAssets, getAllTags, getAllFormats } from '../server/src/db/database.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import { copyAssetToProject } from '../server/src/services/copier.js';

async function runTestPipeline() {
  console.log('🧪 Starting Assettlor Backend Pipeline Verification...');
  const sampleDir = path.join(process.cwd(), 'sample', 'assets');
  const projectDir = path.join(process.cwd(), 'sample', 'game-project');

  // Clean previous output if any
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  // 1. Test scanning & indexing
  console.log('\n--- 1. Testing Scanner & Indexer ---');
  const scanResult = await scanLibrary(sampleDir);
  console.log('Scan result:', scanResult.message);

  const db = getDatabase();
  const assetCount = (db.prepare('SELECT COUNT(*) as count FROM assets').get() as { count: number }).count;
  const stackCount = (db.prepare('SELECT COUNT(*) as count FROM stacks').get() as { count: number }).count;
  const tagCount = (db.prepare('SELECT COUNT(DISTINCT tag) as count FROM tags').get() as { count: number }).count;

  console.log(`Indexed assets: ${assetCount}`);
  console.log(`Detected stacks: ${stackCount}`);
  console.log(`Extracted tags: ${tagCount}`);

  if (assetCount === 0) {
    throw new Error('Assertion failed: No assets indexed!');
  }

  // 2. Test virtual archive inspection
  console.log('\n--- 2. Testing Virtual Zip Archive Inspection ---');
  const zipAssets = db.prepare('SELECT * FROM assets WHERE is_archive_entry = 1').all() as any[];
  console.log(`Zip archive nested items found: ${zipAssets.length}`);
  if (zipAssets.length === 0) {
    throw new Error('Assertion failed: Zip archive assets not indexed virtually!');
  }
  for (const za of zipAssets) {
    console.log(`  - [ZIP] ${za.path} (Size: ${za.size} bytes, Archive: ${path.basename(za.archive_path)})`);
  }

  // 3. Test stacking
  console.log('\n--- 3. Testing Stacking Engine ---');
  const stacks = db.prepare('SELECT * FROM stacks').all() as any[];
  for (const s of stacks) {
    console.log(`  - [STACK ${s.type.toUpperCase()}] "${s.name}" with ${s.item_count} items`);
  }

  const knightStack = stacks.find((s) => s.name.toLowerCase().includes('knight'));
  if (!knightStack) {
    throw new Error('Assertion failed: Knight Walk animation stack not detected!');
  }
  console.log(`✓ Knight Walk animation stacked with ${knightStack.item_count} frames`);

  const laserStack = stacks.find((s) => s.name.toLowerCase().includes('laser'));
  if (!laserStack) {
    throw new Error('Assertion failed: Laser audio stack not detected!');
  }
  console.log(`✓ Laser variations stacked with ${laserStack.item_count} variations`);

  // 4. Test Querying (Stacked vs Flat)
  console.log('\n--- 4. Testing Query Engine (Stacked vs Flat View) ---');
  const stackedRes = queryAssets({ isStackedView: true, limit: 200 });
  console.log(`Stacked view returned items: ${stackedRes.items.length} (total: ${stackedRes.total})`);

  const flatRes = queryAssets({ isStackedView: false, limit: 200 });
  console.log(`Flat view returned items: ${flatRes.items.length} (total: ${flatRes.total})`);

  if (stackedRes.total >= flatRes.total) {
    throw new Error('Assertion failed: Stacked view should group items and have fewer cards than flat view!');
  }
  console.log(`✓ Stacked view correctly consolidated ${flatRes.total} files into ${stackedRes.total} cards`);

  // 4b. Test Search Engine
  console.log('\n--- 4b. Testing Search Engine & Stack Deduplication ---');
  const searchTests = [
    { query: 'knight', expectedStacked: 1, expectedFlat: 4 },
    { query: 'Knight Walk', expectedStacked: 1, expectedFlat: 4 },
    { query: 'Coin_Spin_04', expectedStacked: 1, expectedFlat: 1 },
    { query: 'ui click', expectedStacked: 1, expectedFlat: 2 },
    { query: 'sfx', expectedStacked: 3, expectedFlat: 8 },
  ];

  for (const st of searchTests) {
    const sRes = queryAssets({ search: st.query, isStackedView: true });
    const sIds = sRes.items.map((i: any) => i.id);
    const hasDupes = sIds.some((id: string, idx: number) => sIds.indexOf(id) !== idx);
    if (hasDupes) {
      throw new Error(`Assertion failed: Search "${st.query}" in stacked view returned duplicate IDs!`);
    }
    if (sRes.items.length !== st.expectedStacked) {
      throw new Error(`Assertion failed: Search "${st.query}" expected ${st.expectedStacked} stacked items, got ${sRes.items.length}`);
    }

    const fRes = queryAssets({ search: st.query, isStackedView: false });
    if (fRes.items.length !== st.expectedFlat) {
      throw new Error(`Assertion failed: Search "${st.query}" expected ${st.expectedFlat} flat items, got ${fRes.items.length}`);
    }
    console.log(`✓ Search "${st.query}": ${sRes.items.length} stacked, ${fRes.items.length} flat, 0 duplicates`);
  }

  // 4c. Test Tag Filtering Engine
  console.log('\n--- 4c. Testing Tag Filtering Engine ---');
  const tagTests = [
    { tag: 'pixel-art', expectedStacked: 2 },
    { tag: '#pixel-art', expectedStacked: 2 },
    { tag: 'RetroPack', expectedStacked: 4 },
    { tag: '#retropack', expectedStacked: 4 },
    { tag: 'animated', expectedStacked: 1 },
    { tag: '#coins', expectedStacked: 3 },
  ];

  for (const tt of tagTests) {
    const tRes = queryAssets({ tag: tt.tag, isStackedView: true });
    if (tRes.items.length !== tt.expectedStacked) {
      throw new Error(`Assertion failed: Tag filter "${tt.tag}" expected ${tt.expectedStacked} items, got ${tRes.items.length}`);
    }
    console.log(`✓ Tag filter "${tt.tag}": ${tRes.items.length} items returned correctly`);
  }

  // 5. Test Copy to Game Project
  console.log('\n--- 5. Testing "Copy to Game Project" Workflow ---');
  fs.mkdirSync(projectDir, { recursive: true });

  // A: Copy regular asset
  const regularAsset = db.prepare("SELECT id, name FROM assets WHERE is_archive_entry = 0 AND category = 'image' LIMIT 1").get() as any;
  const copyRes1 = await copyAssetToProject({
    assetId: regularAsset.id,
    targetPath: projectDir,
  });
  console.log('✓ Copied regular asset:', copyRes1.message);

  // B: Copy archive-virtual asset (on-the-fly extraction)
  const zipAsset = zipAssets[0];
  const copyRes2 = await copyAssetToProject({
    assetId: zipAsset.id,
    targetPath: projectDir,
  });
  console.log('✓ Copied archive virtual asset on-the-fly:', copyRes2.message);

  // C: Copy entire animation stack
  const copyRes3 = await copyAssetToProject({
    stackId: knightStack.id,
    targetPath: projectDir,
    copyStackAll: true,
  });
  console.log('✓ Copied entire animation stack:', copyRes3.message);

  // Verify files on disk
  const projectFiles = fs.readdirSync(projectDir);
  console.log(`Project files written:`, projectFiles);

  const knightFolder = path.join(projectDir, knightStack.name.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (fs.existsSync(knightFolder)) {
    const knightFrames = fs.readdirSync(knightFolder);
    console.log(`Knight animation folder contents:`, knightFrames);
    if (knightFrames.length !== knightStack.item_count) {
      throw new Error(`Assertion failed: Expected ${knightStack.item_count} frames, got ${knightFrames.length}`);
    }
  } else {
    throw new Error('Assertion failed: Knight stack destination folder not found!');
  }

  console.log('\n🎉 ALL PIPELINE TESTS PASSED SUCCESSFULLY! 🎉\n');
}

runTestPipeline().catch((err) => {
  console.error('❌ Pipeline Test Failed:', err);
  process.exit(1);
});
