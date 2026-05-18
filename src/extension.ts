/* eslint-disable curly */

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
	
	console.log('Congratulations, your extension "Smart Sequencer" is now active!');
	
	const disposable = [vscode.commands.registerCommand('smart-sequencer.helloWorld', (...args): void => {
		vscode.window.showInformationMessage('Hello World from "Smart Sequencer"!:\n' + args);
	}), vscode.commands.registerCommand('smart-sequencer.insert', (): void => {
		InsertNums();
	}),vscode.commands.registerCommand('smart-sequencer.modification', (): void => {
		try {
			ModificationNums();
		}catch(e) {
			vscode.window.showErrorMessage('エラーが発生したよ: ' + (e instanceof Error ? e.message : String(e)));
		}
	})];
	
	context.subscriptions.push(...disposable);
}

export function deactivate(): void {}

async function InsertNums(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	// 1. 形式を選択
	const items = [
		{ label: '0, 1, 2, ...', value: 'normal' },
		{ label: '0x0, 0x1, 0x2, ...', value: 'hex__raw' },
		{ label: '1 << n, 1 << n+1, ...', value: 'bitshift__raw' },
		{ label: '0, 1, ..., A, B, ...', value: "hex__n" },
		{ label: '1, 2, 4, ...', value: "bitshift_n" }
	];
	const pick = await vscode.window.showQuickPick(items, { placeHolder: '形式を選んでね' });
	if (!pick) return;

	// 2. 開始数値（またはn）を入力
	const startInput = await vscode.window.showInputBox({
		prompt: '開始する数値を入力してください',
		value: '0',
		validateInput: text => isNaN(parseInt(text)) ? '数字を入れてね' : null
	});
	if (startInput === undefined) return;
	const startNum = parseInt(startInput);

	// 3. エディタ上の位置でソート（上から順に連番を振るため）
	const selections = Array.from(editor.selections).sort((a, b) => a.start.compareTo(b.start));

	editor.edit(editBuilder => {
		selections.forEach((selection, i): void => {
			let text = '';
			const current = startNum + i;
			
			switch (pick.value) {
				case 'normal': text = String(current); break;
				case 'hex__raw': text = '0x' + current.toString(16).toUpperCase(); break;
				case 'bitshift__raw': text = `1 << ${current}`; break;
				case "hex__n": text = current.toString(16).toUpperCase(); break;
				case "bitshift_n": text = String(1 << current); break;
			}
			
			// 【ここがポイント】
			// selection（選択範囲）を指定して replace することで、
			// 選択されている場合は「置き換え」、ただのカーソルの場合は「挿入」になります。
			editBuilder.replace(selection, text);
		});
	});
}



function ModificationNums(): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const selection = editor.selection;
	const document = editor.document;
	const text = document.getText(selection);

	// 正規表現: 引用符のペアを \1 でチェックしつつ、数値/16進数/ビットシフトを網羅
	// グループ: 1=開始クォート, 2=ビットシフト左辺, 3=ビットシフト右辺, 4=0x付き/大文字16進数/10進数
	const regex = /\b(?:([\"\']?)(?:(?:(\d+)\s*<<\s*(\d+))|(0x[0-9a-fA-F]+|\d+))\1)\b/g;
	
	const matches = Array.from(text.matchAll(regex)).filter(m => {
		const body = m[4] || m[3]; // 数値本体
		if (!body) return false;
		// 0xなしで英字を含む場合、全部大文字かつA-Fを含む時だけ許可（単語誤爆防止）
		if (!body.toLowerCase().startsWith('0x') && /[a-zA-Z]/.test(body)) {
			return body === body.toUpperCase() && /[A-F]/.test(body);
		}
		return true;
	});

	if (matches.length < 1) return;

	// --- 1. 多数派の桁数と開始値を計算 ---
	const getVal = (m: RegExpMatchArray) => {
		const raw = m[4] || m[3];
		return raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
	};

	const v0 = getVal(matches[0]);
	const lengthCounts = new Map<number, number>(); let isPad = false;
	matches.forEach(m => {
		const body = m[4] || m[3];
		const len = body.toLowerCase().startsWith('0x') ? body.length - 2 : body.length;
		lengthCounts.set(len, (lengthCounts.get(len) || 0) + 1);
		isPad ||= body.toLowerCase().startsWith('0x')? (body.toLowerCase().startsWith("0x0") && body.toLowerCase() !== "0x0"): (body.toLowerCase().startsWith("0") && body.toLowerCase() !== "0");
	});
	const majorityLength0 = [...lengthCounts.entries()].reduce((a, b): [number, number] => b[1] > a[1] ? b : a)[0];
	const majorityLength = isPad? majorityLength0: 1;

	// --- 2. 数列アルゴリズムの推測 ---
	let nextVal = (c: number): number => c + 1;
	if (matches.length >= 3) {
		const [v1, v2] = [getVal(matches[1]), getVal(matches[2])];
		if ((v0 !== 0 && (v1 / v0 === v2 / v1))) nextVal = (c): number => c * (v2 / v1);
		else if (v1 - v0 === v2 - v1) nextVal = (c): number => c + (v1 - v0);
	} else if (matches.length === 2) {
		const v1 = getVal(matches[1]);
		nextVal = (c): number => c + (v1 - v0 || 1);
	}

	// --- 3. 置換実行 ---
	const edits: vscode.TextEdit[] = [];
	const offset = document.offsetAt(selection.start);
	let currentVal = v0;

	matches.forEach((match, i) => {
		if (i > 0) currentVal = nextVal(currentVal);
		
		const fullMatchText = match[0];
		const quote = match[1] || '';
		const isBitShift = !!match[2];
		const rawBody = match[4] || match[3];

		let replacementBody: string;
		const isHex = rawBody.toLowerCase().startsWith('0x') || (rawBody === rawBody.toUpperCase() && /[A-F]/.test(rawBody));

		if (isHex) {
			const hex = currentVal.toString(16);
			const isUpper = /[A-F]/.test(rawBody) || rawBody.startsWith('0X');
			const formatted = (isUpper ? hex.toUpperCase() : hex).padStart(majorityLength, '0');
			replacementBody = (rawBody.toLowerCase().startsWith('0x') ? (rawBody.startsWith('0X') ? '0X' : '0x') : '') + formatted;
		} else {
			replacementBody = String(currentVal).padStart(majorityLength, '0');
		}

		const finalStr = isBitShift 
			? `${quote}${match[2]}${match[0].split('<<')[0].includes('<<') ? '' : ' << '}${replacementBody}${quote}`
			: `${quote}${replacementBody}${quote}`;

		const startPos = document.positionAt(offset + match.index!);
		const endPos = document.positionAt(offset + match.index! + fullMatchText.length);
		edits.push(vscode.TextEdit.replace(new vscode.Range(startPos, endPos), finalStr));
	});

	applyEdits(document, edits, `${edits.length}箇所を究極の空気読みで修正したよ！`);
}







/** 共通の反映処理 */
function applyEdits(document: vscode.TextDocument, edits: vscode.TextEdit[], successMsg: string): void {
	if (edits.length === 0) return;
	
	const workEdit = new vscode.WorkspaceEdit();
	workEdit.set(document.uri, edits);
	// VS Codeに編集内容を反映させる
	vscode.workspace.applyEdit(workEdit).then(success => {
		if (success) vscode.window.showInformationMessage(successMsg);
	});
}