/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import {GoogleGenAI} from '@google/genai';
import {marked} from 'marked';

const MODEL_NAME = 'gemini-2.5-flash';

interface Note {
  id: string;
  rawTranscription: string;
  polishedNote: string;
  timestamp: number;
}

class VoiceNotesApp {
  // FIX: Updated genAI property to use the GoogleGenAI type for better type safety.
  private genAI: GoogleGenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement;
  private newButton: HTMLButtonElement;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private currentNote: Note | null = null;
  private stream: MediaStream | null = null;
  private editorTitle: HTMLDivElement;
  private hasAttemptedPermission = false;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  private instructionsButton: HTMLButtonElement;
  private instructionsModal: HTMLDivElement;
  private closeInstructionsButton: HTMLButtonElement;

  constructor() {
    // FIX: Updated GoogleGenAI initialization to use the correct API key environment variable and remove the deprecated apiVersion parameter, ensuring compatibility with the current Gemini API.
    this.genAI = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.polishedNote = document.getElementById(
      'polishedNote',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.editorTitle = document.querySelector(
      '.editor-title',
    ) as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;

    this.instructionsButton = document.getElementById(
      'instructionsButton',
    ) as HTMLButtonElement;
    this.instructionsModal = document.getElementById(
      'instructionsModal',
    ) as HTMLDivElement;
    this.closeInstructionsButton = document.getElementById(
      'closeInstructionsButton',
    ) as HTMLButtonElement;

    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    } else {
      console.warn(
        'Live waveform canvas element not found. Visualizer will not work.',
      );
    }

    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    } else {
      console.warn('Recording interface element not found.');
      this.statusIndicatorDiv = null;
    }

    this.bindEventListeners();
    this.createNewNote();

    this.recordingStatus.textContent = 'Sẵn sàng ghi âm';
  }

  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.createNewNote());
    this.instructionsButton.addEventListener('click', () =>
      this.showInstructions(),
    );
    this.closeInstructionsButton.addEventListener('click', () =>
      this.hideInstructions(),
    );
    this.instructionsModal.addEventListener('click', (e) => {
      if (e.target === this.instructionsModal) {
        this.hideInstructions();
      }
    });
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  private showInstructions(): void {
    this.instructionsModal.classList.add('is-visible');
  }

  private hideInstructions(): void {
    this.instructionsModal.classList.remove('is-visible');
  }

  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private async toggleRecording(): Promise<void> {
    if (!this.isRecording) {
      await this.startRecording();
    } else {
      await this.stopRecording();
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return;

    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.75;

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);

    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5);

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars));
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1;
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      console.warn(
        'One or more live display elements are missing. Cannot start live display.',
      );
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }

    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder =
      this.editorTitle.getAttribute('placeholder') || 'Ghi chú không tiêu đề';
    this.liveRecordingTitle.textContent =
      currentTitle && currentTitle !== placeholder
        ? currentTitle
        : 'Bản ghi mới';

    this.setupAudioVisualizer();
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }

    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext
          .close()
          .catch((e) => console.warn('Error closing audio context', e));
      }
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.waveformDataArray = null;
  }

  private async startRecording(): Promise<void> {
    try {
      this.audioChunks = [];
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
      }

      this.recordingStatus.textContent = 'Đang yêu cầu quyền truy cập micrô...';

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        console.error('Failed with basic constraints:', err);
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      try {
        this.mediaRecorder = new MediaRecorder(this.stream, {
          mimeType: 'audio/webm',
        });
      } catch (e) {
        console.error('audio/webm not supported, trying default:', e);
        this.mediaRecorder = new MediaRecorder(this.stream);
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        this.stopLiveDisplay();

        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, {
            type: this.mediaRecorder?.mimeType || 'audio/webm',
          });
          this.processAudio(audioBlob).catch((err) => {
            console.error('Error processing audio:', err);
            this.recordingStatus.textContent = 'Lỗi xử lý bản ghi';
          });
        } else {
          this.recordingStatus.textContent =
            'Không có dữ liệu âm thanh nào được ghi lại. Vui lòng thử lại.';
        }

        if (this.stream) {
          this.stream.getTracks().forEach((track) => {
            track.stop();
          });
          this.stream = null;
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;

      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Dừng ghi âm');

      this.startLiveDisplay();
    } catch (error) {
      console.error('Error starting recording:', error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';

      if (
        errorName === 'NotAllowedError' ||
        errorName === 'PermissionDeniedError'
      ) {
        this.recordingStatus.textContent =
          'Quyền truy cập micrô bị từ chối. Vui lòng kiểm tra cài đặt trình duyệt và tải lại trang.';
      } else if (
        errorName === 'NotFoundError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Requested device not found'))
      ) {
        this.recordingStatus.textContent =
          'Không tìm thấy micrô. Vui lòng kết nối micrô.';
      } else if (
        errorName === 'NotReadableError' ||
        errorName === 'AbortError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Failed to allocate audiosource'))
      ) {
        this.recordingStatus.textContent =
          'Không thể truy cập micrô. Micrô có thể đang được sử dụng bởi một ứng dụng khác.';
      } else {
        this.recordingStatus.textContent = `Lỗi: ${errorMessage}`;
      }

      this.isRecording = false;
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Bắt đầu ghi âm');
      this.stopLiveDisplay();
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.error('Error stopping MediaRecorder:', e);
        this.stopLiveDisplay();
      }

      this.isRecording = false;

      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Bắt đầu ghi âm');
      this.recordingStatus.textContent = 'Đang xử lý âm thanh...';
    } else {
      if (!this.isRecording) this.stopLiveDisplay();
    }
  }

  private async processAudio(audioBlob: Blob): Promise<void> {
    if (audioBlob.size === 0) {
      this.recordingStatus.textContent =
        'Không có dữ liệu âm thanh nào được ghi lại. Vui lòng thử lại.';
      return;
    }

    try {
      URL.createObjectURL(audioBlob);

      this.recordingStatus.textContent = 'Đang chuyển đổi âm thanh...';

      const reader = new FileReader();
      const readResult = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          try {
            const base64data = reader.result as string;
            const base64Audio = base64data.split(',')[1];
            resolve(base64Audio);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(reader.error);
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await readResult;

      if (!base64Audio) throw new Error('Không thể chuyển đổi âm thanh sang base64');

      const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
      await this.getTranscription(base64Audio, mimeType);
    } catch (error) {
      console.error('Error in processAudio:', error);
      this.recordingStatus.textContent =
        'Lỗi xử lý bản ghi. Vui lòng thử lại.';
    }
  }

  private async getTranscription(
    base64Audio: string,
    mimeType: string,
  ): Promise<void> {
    try {
      this.recordingStatus.textContent = 'Đang lấy bản ghi âm...';

      const contents = [
        {text: 'Generate a complete, detailed transcript of this audio.'},
        {inlineData: {mimeType: mimeType, data: base64Audio}},
      ];

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });

      // FIX: The .text property on a GenerateContentResponse is a string, not a promise.
      const transcriptionText = response.text;

      if (transcriptionText) {
        this.rawTranscription.textContent = transcriptionText;
        if (transcriptionText.trim() !== '') {
          this.rawTranscription.classList.remove('placeholder-active');
        } else {
          const placeholder =
            this.rawTranscription.getAttribute('placeholder') || '';
          this.rawTranscription.textContent = placeholder;
          this.rawTranscription.classList.add('placeholder-active');
        }

        if (this.currentNote)
          this.currentNote.rawTranscription = transcriptionText;
        this.recordingStatus.textContent =
          'Ghi âm hoàn tất. Đang trau chuốt ghi chú...';
        this.getPolishedNote().catch((err) => {
          console.error('Error polishing note:', err);
          this.recordingStatus.textContent =
            'Lỗi trau chuốt ghi chú sau khi ghi âm.';
        });
      } else {
        this.recordingStatus.textContent =
          'Ghi âm thất bại hoặc không có nội dung.';
        this.polishedNote.innerHTML =
          '<p><em>Không thể ghi âm. Vui lòng thử lại.</em></p>';
        this.rawTranscription.textContent =
          this.rawTranscription.getAttribute('placeholder');
        this.rawTranscription.classList.add('placeholder-active');
      }
    } catch (error) {
      console.error('Error getting transcription:', error);
      this.recordingStatus.textContent =
        'Lỗi lấy bản ghi âm. Vui lòng thử lại.';
      this.polishedNote.innerHTML = `<p><em>Lỗi trong quá trình ghi âm: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      this.rawTranscription.textContent =
        this.rawTranscription.getAttribute('placeholder');
      this.rawTranscription.classList.add('placeholder-active');
    }
  }

  private async getPolishedNote(): Promise<void> {
    try {
      if (
        !this.rawTranscription.textContent ||
        this.rawTranscription.textContent.trim() === '' ||
        this.rawTranscription.classList.contains('placeholder-active')
      ) {
        this.recordingStatus.textContent = 'Không có bản ghi âm để trau chuốt';
        this.polishedNote.innerHTML =
          '<p><em>Không có bản ghi âm để trau chuốt.</em></p>';
        const placeholder = this.polishedNote.getAttribute('placeholder') || '';
        this.polishedNote.innerHTML = placeholder;
        this.polishedNote.classList.add('placeholder-active');
        return;
      }

      this.recordingStatus.textContent = 'Đang trau chuốt ghi chú...';

      const prompt = `Take this raw transcription and create a polished, well-formatted note.
                    Remove filler words (um, uh, like), repetitions, and false starts.
                    Format any lists or bullet points properly. Use markdown formatting for headings, lists, etc.
                    Maintain all the original content and meaning.

                    Raw transcription:
                    ${this.rawTranscription.textContent}`;
      const contents = [{text: prompt}];

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });
      // FIX: The .text property on a GenerateContentResponse is a string, not a promise.
      const polishedText = response.text;

      if (polishedText) {
        const htmlContent = marked.parse(polishedText);
        this.polishedNote.innerHTML = htmlContent;
        if (polishedText.trim() !== '') {
          this.polishedNote.classList.remove('placeholder-active');
        } else {
          const placeholder =
            this.polishedNote.getAttribute('placeholder') || '';
          this.polishedNote.innerHTML = placeholder;
          this.polishedNote.classList.add('placeholder-active');
        }

        let noteTitleSet = false;
        const lines = polishedText.split('\n').map((l) => l.trim());

        for (const line of lines) {
          if (line.startsWith('#')) {
            const title = line.replace(/^#+\s+/, '').trim();
            if (this.editorTitle && title) {
              this.editorTitle.textContent = title;
              this.editorTitle.classList.remove('placeholder-active');
              noteTitleSet = true;
              break;
            }
          }
        }

        if (!noteTitleSet && this.editorTitle) {
          for (const line of lines) {
            if (line.length > 0) {
              let potentialTitle = line.replace(
                /^[\*_\`#\->\s\[\]\(.\d)]+/,
                '',
              );
              potentialTitle = potentialTitle.replace(/[\*_\`#]+$/, '');
              potentialTitle = potentialTitle.trim();

              if (potentialTitle.length > 3) {
                const maxLength = 60;
                this.editorTitle.textContent =
                  potentialTitle.substring(0, maxLength) +
                  (potentialTitle.length > maxLength ? '...' : '');
                this.editorTitle.classList.remove('placeholder-active');
                noteTitleSet = true;
                break;
              }
            }
          }
        }

        if (!noteTitleSet && this.editorTitle) {
          const currentEditorText = this.editorTitle.textContent?.trim();
          const placeholderText =
            this.editorTitle.getAttribute('placeholder') || 'Ghi chú không tiêu đề';
          if (
            currentEditorText === '' ||
            currentEditorText === placeholderText
          ) {
            this.editorTitle.textContent = placeholderText;
            if (!this.editorTitle.classList.contains('placeholder-active')) {
              this.editorTitle.classList.add('placeholder-active');
            }
          }
        }

        if (this.currentNote) this.currentNote.polishedNote = polishedText;
        this.recordingStatus.textContent =
          'Ghi chú đã được trau chuốt. Sẵn sàng cho bản ghi tiếp theo.';
      } else {
        this.recordingStatus.textContent =
          'Trau chuốt thất bại hoặc không có nội dung.';
        this.polishedNote.innerHTML =
          '<p><em>Trau chuốt không có nội dung. Bản ghi âm thô vẫn có sẵn.</em></p>';
        if (
          this.polishedNote.textContent?.trim() === '' ||
          this.polishedNote.innerHTML.includes('<em>Trau chuốt không có nội dung')
        ) {
          const placeholder =
            this.polishedNote.getAttribute('placeholder') || '';
          this.polishedNote.innerHTML = placeholder;
          this.polishedNote.classList.add('placeholder-active');
        }
      }
    } catch (error) {
      console.error('Error polishing note:', error);
      this.recordingStatus.textContent =
        'Lỗi trau chuốt ghi chú. Vui lòng thử lại.';
      this.polishedNote.innerHTML = `<p><em>Lỗi trong quá trình trau chuốt: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      if (
        this.polishedNote.textContent?.trim() === '' ||
        this.polishedNote.innerHTML.includes('<em>Lỗi trong quá trình trau chuốt')
      ) {
        const placeholder = this.polishedNote.getAttribute('placeholder') || '';
        this.polishedNote.innerHTML = placeholder;
        this.polishedNote.classList.add('placeholder-active');
      }
    }
  }

  private createNewNote(): void {
    this.currentNote = {
      id: `note_${Date.now()}`,
      rawTranscription: '',
      polishedNote: '',
      timestamp: Date.now(),
    };

    const rawPlaceholder =
      this.rawTranscription.getAttribute('placeholder') || '';
    this.rawTranscription.textContent = rawPlaceholder;
    this.rawTranscription.classList.add('placeholder-active');

    const polishedPlaceholder =
      this.polishedNote.getAttribute('placeholder') || '';
    this.polishedNote.innerHTML = polishedPlaceholder;
    this.polishedNote.classList.add('placeholder-active');

    if (this.editorTitle) {
      const placeholder =
        this.editorTitle.getAttribute('placeholder') || 'Ghi chú không tiêu đề';
      this.editorTitle.textContent = placeholder;
      this.editorTitle.classList.add('placeholder-active');
    }
    this.recordingStatus.textContent = 'Sẵn sàng ghi âm';

    if (this.isRecording) {
      this.mediaRecorder?.stop();
      this.isRecording = false;
      this.recordButton.classList.remove('recording');
    } else {
      this.stopLiveDisplay();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VoiceNotesApp();

  document
    .querySelectorAll<HTMLElement>('[contenteditable][placeholder]')
    .forEach((el) => {
      const placeholder = el.getAttribute('placeholder')!;

      function updatePlaceholderState() {
        const currentText = (
          el.id === 'polishedNote' ? el.innerText : el.textContent
        )?.trim();

        if (currentText === '' || currentText === placeholder) {
          if (el.id === 'polishedNote' && currentText === '') {
            el.innerHTML = placeholder;
          } else if (currentText === '') {
            el.textContent = placeholder;
          }
          el.classList.add('placeholder-active');
        } else {
          el.classList.remove('placeholder-active');
        }
      }

      updatePlaceholderState();

      el.addEventListener('focus', function () {
        const currentText = (
          this.id === 'polishedNote' ? this.innerText : this.textContent
        )?.trim();
        if (currentText === placeholder) {
          if (this.id === 'polishedNote') this.innerHTML = '';
          else this.textContent = '';
          this.classList.remove('placeholder-active');
        }
      });

      el.addEventListener('blur', function () {
        updatePlaceholderState();
      });
    });
});

export {};
