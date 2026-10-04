import path from 'path';
import fs from 'fs';
import { initDatabase, getDatabase, queryAssets, getAllTags, getAllFormats } from '../server/src/db/database.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import { copyAssetToProject } from '../server/src/services/copier.js';

async function runTestPipeline() {
  console.log('🧪 Starting Assettlor Backend Pipeline Verification...');
  const sampleDir = path.join(process.cwd(), 'sample-assets');
  const projectDir = path.join(process.cwd(), 'sample-game-project');

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
  const stackedRes = queryAssets({ isStackedView: true });
  console.log(`Stacked view returned items: ${stackedRes.items.length}`);

  const flatRes = queryAssets({ isStackedView: false });
  console.log(`Flat view returned items: ${flatRes.items.length}`);

  if (stackedRes.items.length >= flatRes.items.length) {
    throw new Error('Assertion failed: Stacked view should group items and have fewer cards than flat view!');
  }
  console.log(`✓ Stacked view correctly consolidated ${flatRes.items.length} files into ${stackedRes.items.length} cards`);

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
