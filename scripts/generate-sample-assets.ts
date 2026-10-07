import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';

const sampleDir = path.join(process.cwd(), 'sample', 'assets');

// Helper to generate a valid PCM WAV buffer
function createWavBuffer({
  durationSeconds = 1.0,
  sampleRate = 44100,
  frequencyFn,
  amplitudeFn,
}: {
  durationSeconds?: number;
  sampleRate?: number;
  frequencyFn: (t: number) => number;
  amplitudeFn?: (t: number) => number;
}): Buffer {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * 2; // 16-bit mono = 2 bytes per sample
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // "fmt " subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(1, 22);  // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32);  // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // "data" subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Synthesize audio
  let phase = 0;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = frequencyFn(t);
    phase += (2 * Math.PI * freq) / sampleRate;
    const amp = amplitudeFn ? amplitudeFn(t) : 1.0;
    const sample = Math.sin(phase) * amp;
    const int16 = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    buffer.writeInt16LE(int16, 44 + i * 2);
  }

  return buffer;
}

// Helper to generate valid 32-bit RGBA TGA file
function createTgaBuffer(width: number, height: number, colorGen: (x: number, y: number) => [number, number, number, number]): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 2; // uncompressed true-color
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 32; // 32 bits per pixel (BGRA)
  header[17] = 0x28; // top-to-bottom, 8 bits alpha

  const pixels = Buffer.alloc(width * height * 4);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = colorGen(x, y);
      pixels[offset++] = b;
      pixels[offset++] = g;
      pixels[offset++] = r;
      pixels[offset++] = a;
    }
  }

  return Buffer.concat([header, pixels]);
}

async function createSvgSprite(text: string, color: string, frame: number, totalFrames: number): Promise<Buffer> {
  const size = 128;
  const progress = frame / totalFrames;
  const bounceY = Math.sin(progress * Math.PI) * 16;
  const legOffset = (frame % 2 === 0 ? 1 : -1) * 10;

  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${color}" />
          <stop offset="100%" stop-color="#1e1b4b" />
        </radialGradient>
      </defs>
      <!-- Shadow -->
      <ellipse cx="64" cy="110" rx="${24 - bounceY * 0.4}" ry="6" fill="#000000" opacity="0.4" />
      
      <!-- Character Body -->
      <g transform="translate(0, ${-bounceY})">
        <!-- Torso / Shield -->
        <rect x="44" y="50" width="40" height="42" rx="8" fill="url(#grad)" stroke="#ffffff" stroke-width="2" />
        <!-- Helmet -->
        <circle cx="64" cy="38" r="18" fill="#e2e8f0" stroke="#475569" stroke-width="2" />
        <!-- Visor -->
        <rect x="54" y="34" width="20" height="6" rx="2" fill="#0f172a" />
        <rect x="56" y="35" width="8" height="4" rx="1" fill="#38bdf8" />
        <!-- Plume -->
        <path d="M 64 20 Q 72 10 78 18 Q 70 26 64 24" fill="#ef4444" />
        
        <!-- Legs / Feet -->
        <rect x="${50 + legOffset}" y="92" width="10" height="14" rx="3" fill="#334155" />
        <rect x="${68 - legOffset}" y="92" width="10" height="14" rx="3" fill="#334155" />
      </g>

      <!-- Frame Badge -->
      <rect x="8" y="8" width="48" height="18" rx="4" fill="#0f172a" opacity="0.8" />
      <text x="32" y="21" font-family="monospace" font-size="10" font-weight="bold" fill="#38bdf8" text-anchor="middle">F${frame}/${totalFrames}</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createCoinSprite(frame: number, totalFrames: number): Promise<Buffer> {
  const size = 64;
  const angle = (frame / totalFrames) * Math.PI;
  const scaleX = Math.cos(angle);
  const rx = Math.max(3, Math.abs(scaleX) * 24);

  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fef08a" />
          <stop offset="50%" stop-color="#eab308" />
          <stop offset="100%" stop-color="#ca8a04" />
        </linearGradient>
      </defs>
      <ellipse cx="32" cy="32" rx="${rx}" ry="24" fill="url(#gold)" stroke="#854d0e" stroke-width="2" />
      ${rx > 10 ? `<text x="32" y="37" font-family="sans-serif" font-size="16" font-weight="bold" fill="#713f12" text-anchor="middle">$</text>` : ''}
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function generateSampleAssets() {
  console.log(`Generating realistic sample game assets in: ${sampleDir}...`);

  if (!fs.existsSync(sampleDir)) {
    fs.mkdirSync(sampleDir, { recursive: true });
  }

  // 1. Knight Walk Animation Sequence (4 frames)
  const knightDir = path.join(sampleDir, 'characters', 'knight');
  fs.mkdirSync(knightDir, { recursive: true });
  for (let f = 1; f <= 4; f++) {
    const pngBuf = await createSvgSprite('Knight', '#6366f1', f, 4);
    fs.writeFileSync(path.join(knightDir, `Knight_Walk_0${f}.png`), pngBuf);
  }
  console.log('✓ Generated Knight Walk animation frames (4 frames)');

  // 2. Coin Spin Animation Sequence (6 frames)
  const itemsDir = path.join(sampleDir, 'items', 'coins');
  fs.mkdirSync(itemsDir, { recursive: true });
  for (let f = 1; f <= 6; f++) {
    const coinBuf = await createCoinSprite(f, 6);
    fs.writeFileSync(path.join(itemsDir, `Coin_Spin_0${f}.png`), coinBuf);
  }
  console.log('✓ Generated Coin Spin animation frames (6 frames)');

  // 3. Standalone Images (background.jpg, icon.png, tile.tga, potion.webp, sword.svg)
  const envDir = path.join(sampleDir, 'environment');
  fs.mkdirSync(envDir, { recursive: true });

  // Background scenic JPEG
  const bgSvg = `
    <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="60%" stop-color="#312e81" />
          <stop offset="100%" stop-color="#db2777" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#sky)" />
      <circle cx="520" cy="100" r="50" fill="#fef08a" opacity="0.9" filter="drop-shadow(0 0 16px #fde047)" />
      <!-- Mountain silhouettes -->
      <polygon points="40,360 220,160 380,360" fill="#1e1b4b" opacity="0.8" />
      <polygon points="260,360 440,120 620,360" fill="#1e1b4b" opacity="0.9" />
      <polygon points="-40,360 140,220 320,360" fill="#0f172a" />
      <polygon points="360,360 520,240 680,360" fill="#0f172a" />
    </svg>
  `;
  await sharp(Buffer.from(bgSvg)).jpeg({ quality: 90 }).toFile(path.join(envDir, 'dungeon_background.jpg'));

  // Standalone PNG UI icon
  const iconSvg = `
    <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="iconBg" cx="30%" cy="30%" r="70%">
          <stop offset="0%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#0369a1" />
        </radialGradient>
      </defs>
      <rect width="256" height="256" rx="48" fill="url(#iconBg)" />
      <path d="M 64 64 L 192 192 M 192 64 L 64 192" stroke="#ffffff" stroke-width="24" stroke-linecap="round" />
    </svg>
  `;
  await sharp(Buffer.from(iconSvg)).png().toFile(path.join(sampleDir, 'app_icon.png'));

  // Standalone TGA texture file
  const tgaBuf = createTgaBuffer(64, 64, (x, y) => {
    const isBorder = x === 0 || y === 0 || x === 63 || y === 63;
    const isBrick = (y % 16 === 0) || (Math.floor(y / 16) % 2 === 0 ? x % 32 === 0 : (x + 16) % 32 === 0);
    if (isBorder || isBrick) {
      return [40, 40, 45, 255]; // dark mortar
    }
    const noise = Math.sin(x * 0.5) * Math.cos(y * 0.5) * 20;
    return [Math.floor(160 + noise), Math.floor(90 + noise), Math.floor(70 + noise), 255]; // brick
  });
  fs.writeFileSync(path.join(envDir, 'stone_brick_tile.tga'), tgaBuf);

  // Standalone WebP item
  const potionSvg = `
    <svg width="128" height="128" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="potion" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#f43f5e" />
          <stop offset="100%" stop-color="#881337" />
        </linearGradient>
      </defs>
      <rect x="52" y="20" width="24" height="20" rx="3" fill="#cbd5e1" stroke="#475569" stroke-width="2" />
      <path d="M 52 40 L 32 80 A 32 32 0 0 0 96 80 L 76 40 Z" fill="url(#potion)" stroke="#475569" stroke-width="3" />
      <circle cx="56" cy="72" r="5" fill="#fda4af" opacity="0.8" />
      <circle cx="68" cy="84" r="3" fill="#fda4af" opacity="0.8" />
    </svg>
  `;
  await sharp(Buffer.from(potionSvg)).webp().toFile(path.join(itemsDir, 'health_potion.webp'));

  // Standalone SVG icon
  const swordSvg = `
    <svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
      <path d="M 96 20 L 108 32 L 48 92 L 36 80 Z" fill="#94a3b8" stroke="#334155" stroke-width="2" />
      <path d="M 108 20 L 96 20 L 108 32 Z" fill="#e2e8f0" />
      <rect x="36" y="76" width="16" height="4" transform="rotate(-45 36 76)" fill="#d97706" />
      <rect x="24" y="96" width="8" height="16" transform="rotate(-45 24 96)" fill="#78350f" />
      <circle cx="18" cy="110" r="5" fill="#d97706" />
    </svg>
  `;
  fs.writeFileSync(path.join(itemsDir, 'steel_sword.svg'), swordSvg);
  console.log('✓ Generated standalone images (JPG, PNG, TGA, WEBP, SVG)');

  // 4. Audio Variations:
  // - Laser SFX variation stack: laser_01.wav, laser_02.wav, laser_03.wav
  const sfxDir = path.join(sampleDir, 'audio', 'sfx');
  fs.mkdirSync(sfxDir, { recursive: true });

  // Laser 1: Fast downward sweep
  const laser1 = createWavBuffer({
    durationSeconds: 0.35,
    frequencyFn: (t) => 1200 - t * 2400,
    amplitudeFn: (t) => Math.max(0, 1 - t / 0.35),
  });
  fs.writeFileSync(path.join(sfxDir, 'laser_01.wav'), laser1);

  // Laser 2: Higher pitch downward sweep
  const laser2 = createWavBuffer({
    durationSeconds: 0.28,
    frequencyFn: (t) => 1800 - t * 4000,
    amplitudeFn: (t) => Math.max(0, 1 - t / 0.28),
  });
  fs.writeFileSync(path.join(sfxDir, 'laser_02.wav'), laser2);

  // Laser 3: Dual-tone resonant sweep
  const laser3 = createWavBuffer({
    durationSeconds: 0.4,
    frequencyFn: (t) => 900 - t * 1500,
    amplitudeFn: (t) => Math.max(0, 1 - t / 0.4),
  });
  fs.writeFileSync(path.join(sfxDir, 'laser_03.wav'), laser3);

  // - Explosion variation stack: Explosion_A.wav, Explosion_B.wav
  const explosionA = createWavBuffer({
    durationSeconds: 0.8,
    frequencyFn: (t) => 120 + Math.sin(t * 80) * 40,
    amplitudeFn: (t) => Math.pow(Math.max(0, 1 - t / 0.8), 2),
  });
  fs.writeFileSync(path.join(sfxDir, 'Explosion_A.wav'), explosionA);

  const explosionB = createWavBuffer({
    durationSeconds: 1.1,
    frequencyFn: (t) => 80 + Math.sin(t * 50) * 30,
    amplitudeFn: (t) => Math.pow(Math.max(0, 1 - t / 1.1), 1.8),
  });
  fs.writeFileSync(path.join(sfxDir, 'Explosion_B.wav'), explosionB);

  // - Footstep variation stack: footstep_01.wav, footstep_02.wav, footstep_03.wav
  for (let i = 1; i <= 3; i++) {
    const pitch = 220 + i * 40;
    const footstep = createWavBuffer({
      durationSeconds: 0.18,
      frequencyFn: () => pitch,
      amplitudeFn: (t) => Math.sin((t / 0.18) * Math.PI) * Math.exp(-t * 15),
    });
    fs.writeFileSync(path.join(sfxDir, `footstep_0${i}.wav`), footstep);
  }

  // - Ambient chime / melody audio: ambient_melody.wav
  const ambientWav = createWavBuffer({
    durationSeconds: 3.5,
    frequencyFn: (t) => {
      // Gentle chord arpeggio: C4 (261), E4 (329), G4 (392), B4 (493)
      const note = Math.floor(t * 2) % 4;
      const notes = [261.63, 329.63, 392.0, 493.88];
      return notes[note];
    },
    amplitudeFn: (t) => 0.6 * (1 - t / 3.5),
  });
  fs.writeFileSync(path.join(sampleDir, 'audio', 'ambient_chime.wav'), ambientWav);
  console.log('✓ Generated audio variation files and sound effects (WAV)');

  // 5. Virtual Archive: RetroPack.zip
  const zip = new AdmZip();

  // Nested Hero Jump animation sequence inside zip
  for (let f = 1; f <= 3; f++) {
    const jumpBuf = await createSvgSprite('Jump', '#10b981', f, 3);
    zip.addFile(`sprites/Hero_Jump_0${f}.png`, jumpBuf);
  }

  // UI buttons inside zip
  const playBtnSvg = `
    <svg width="160" height="48" xmlns="http://www.w3.org/2000/svg">
      <rect width="160" height="48" rx="8" fill="#10b981" stroke="#059669" stroke-width="2" />
      <polygon points="68,16 68,32 84,24" fill="#ffffff" />
      <text x="96" y="29" font-family="sans-serif" font-size="14" font-weight="bold" fill="#ffffff">PLAY</text>
    </svg>
  `;
  const playBtnBuf = await sharp(Buffer.from(playBtnSvg)).png().toBuffer();
  zip.addFile('ui/button_play.png', playBtnBuf);

  const pauseBtnSvg = `
    <svg width="160" height="48" xmlns="http://www.w3.org/2000/svg">
      <rect width="160" height="48" rx="8" fill="#f59e0b" stroke="#d97706" stroke-width="2" />
      <rect x="68" y="16" width="6" height="16" rx="2" fill="#ffffff" />
      <rect x="80" y="16" width="6" height="16" rx="2" fill="#ffffff" />
      <text x="96" y="29" font-family="sans-serif" font-size="14" font-weight="bold" fill="#ffffff">PAUSE</text>
    </svg>
  `;
  const pauseBtnBuf = await sharp(Buffer.from(pauseBtnSvg)).png().toBuffer();
  zip.addFile('ui/button_pause.png', pauseBtnBuf);

  // Click sounds inside zip
  const click1 = createWavBuffer({
    durationSeconds: 0.1,
    frequencyFn: () => 800,
    amplitudeFn: (t) => Math.exp(-t * 40),
  });
  zip.addFile('audio/ui_click_01.wav', click1);

  const click2 = createWavBuffer({
    durationSeconds: 0.1,
    frequencyFn: () => 1200,
    amplitudeFn: (t) => Math.exp(-t * 50),
  });
  zip.addFile('audio/ui_click_02.wav', click2);

  const zipPath = path.join(sampleDir, 'RetroPack.zip');
  zip.writeZip(zipPath);
  console.log(`✓ Generated virtual archive: ${zipPath}`);

  console.log('\n Sample game assets generation complete!');
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateSampleAssets().catch(console.error);
}
