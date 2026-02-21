export class MockContext2D {
  fillStyle: string = '';
  strokeStyle: string = '';
  font: string = '';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha: number = 1.0;
  lineWidth: number = 1;

  fillRect(_x: number, _y: number, _w: number, _h: number): void {}
  fillText(_text: string, _x: number, _y: number): void {}
  clearRect(_x: number, _y: number, _w: number, _h: number): void {}
  strokeRect(_x: number, _y: number, _w: number, _h: number): void {}

  measureText(text: string): TextMetrics {
    // Approximate monospace width: 7.8px per character at 12px font size
    const width = text.length * 7.8;
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 2,
      alphabeticBaseline: 0,
      emHeightAscent: 10,
      emHeightDescent: 2,
      hangingBaseline: 8,
      ideographicBaseline: 0,
    } as TextMetrics;
  }

  setTransform(
    _a: number, _b: number, _c: number, _d: number, _e: number, _f: number,
  ): void {}

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  closePath(): void {}
  stroke(): void {}
  fill(): void {}
}

export class MockCanvas {
  width: number;
  height: number;
  style: { width: string; height: string } = { width: '', height: '' };

  private _ctx = new MockContext2D();

  constructor(width = 800, height = 600) {
    this.width = width;
    this.height = height;
  }

  getContext(_contextId: string): MockContext2D {
    return this._ctx;
  }

  getBoundingClientRect(): DOMRect {
    return {
      width: this.width,
      height: this.height,
      left: 0,
      top: 0,
      right: this.width,
      bottom: this.height,
      x: 0,
      y: 0,
      toJSON() { return this; },
    };
  }
}
