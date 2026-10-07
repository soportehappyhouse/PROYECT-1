/**
 * Audit fix 20: uploaded audio (Person voice samples, «Voz propia») reaches ffmpeg with the demuxer
 * chosen from the REAL type (magic bytes), never from the client's file name, and only the
 * `file`/`pipe` protocols: a playlist (.m3u8, .concat, …) disguised as a sample cannot make ffmpeg
 * read other files or open URLs.
 */

export interface AudioType {
  /** Extension of the server-generated input name. */
  ext: "wav" | "mp3" | "ogg" | "webm" | "m4a" | "flac" | "aac";
  /** ffmpeg demuxer forced with `-f`. */
  format: "wav" | "mp3" | "ogg" | "matroska" | "mov" | "flac" | "aac";
}

/** Real container of an uploaded audio file, or undefined (not a supported audio type). */
export function sniffAudio(buf: Buffer): AudioType | undefined {
  if (buf.length < 12) return undefined;
  const ascii = (a: number, b: number) => buf.toString("ascii", a, b);
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { ext: "wav", format: "wav" };
  if (ascii(0, 4) === "OggS") return { ext: "ogg", format: "ogg" };
  if (ascii(0, 4) === "fLaC") return { ext: "flac", format: "flac" };
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { ext: "webm", format: "matroska" };
  if (ascii(4, 8) === "ftyp") return { ext: "m4a", format: "mov" };
  if (ascii(0, 3) === "ID3") return { ext: "mp3", format: "mp3" };
  if (buf[0] === 0xff) {
    const b1 = buf[1]!;
    if ((b1 & 0xf6) === 0xf0) return { ext: "aac", format: "aac" }; // ADTS
    if ((b1 & 0xe0) === 0xe0 && ((b1 >> 1) & 0x03) !== 0) return { ext: "mp3", format: "mp3" };
  }
  return undefined;
}

/** ffmpeg input options for an uploaded file of type `t` (put right before `-i <input>`). */
export function safeInputArgs(t: AudioType): string[] {
  return ["-protocol_whitelist", "file,pipe", "-f", t.format];
}
