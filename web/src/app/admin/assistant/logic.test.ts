import { describe, expect, it } from 'vitest';
import type { AdminAssistantMessage, AdminAssistantSurveyEntry, AdminAssistantUnansweredItem } from '@shared/contracts';
import { annotateDialog, conversationHref, spaceOptionLabels, unansweredQuestionTexts } from './logic';

const USER = { id: 'u1', name: 'Olha', email: 'olha@t.local' };

function message(id: string, role: 'user' | 'assistant', createdAt: string): AdminAssistantMessage {
  return { id, role, content: id, createdAt, feedback: null, space: 'eng', spaceName: 'Engineering' };
}

function report(id: string, createdAt: string): AdminAssistantUnansweredItem {
  return { id, conversationId: 'c1', user: USER, space: 'eng', spaceName: 'Engineering', pageId: null, question: id, userQuestion: null, reason: 'no_answer', missing: null, createdAt };
}

const MESSAGES = [
  message('q1', 'user', '2026-10-01T10:00:00.000Z'),
  message('a1', 'assistant', '2026-10-01T10:00:10.000Z'),
  message('q2', 'user', '2026-10-01T10:05:00.000Z'),
  message('a2', 'assistant', '2026-10-01T10:05:10.000Z'),
];

describe('annotateDialog', () => {
  it('puts a report after the answer of the run it was raised in', () => {
    const result = annotateDialog(MESSAGES, [], [report('r1', '2026-10-01T10:00:05.000Z'), report('r2', '2026-10-01T10:05:03.000Z')]);
    expect(result.unansweredAfter.get('a1')?.map((r) => r.id)).toEqual(['r1']);
    expect(result.unansweredAfter.get('a2')?.map((r) => r.id)).toEqual(['r2']);
    expect(result.trailingUnanswered).toEqual([]);
  });

  it('lists a report with no answer after it (a cancelled run) at the end', () => {
    const result = annotateDialog(MESSAGES, [], [report('late', '2026-10-01T11:00:00.000Z')]);
    expect(result.unansweredAfter.size).toBe(0);
    expect(result.trailingUnanswered.map((r) => r.id)).toEqual(['late']);
  });

  it('places surveys by afterMessageId and keeps unknown ones as trailing', () => {
    const surveys: AdminAssistantSurveyEntry[] = [
      { afterMessageId: 'a2', answer: 'partly', comment: 'meh', createdAt: '2026-10-01T10:06:00.000Z' },
      { afterMessageId: 'gone', answer: 'solved', comment: null, createdAt: '2026-10-01T10:07:00.000Z' },
    ];
    const result = annotateDialog(MESSAGES, surveys, []);
    expect(result.surveysAfter.get('a2')?.[0]?.comment).toBe('meh');
    expect(result.trailingSurveys.map((s) => s.afterMessageId)).toEqual(['gone']);
  });
});

describe('conversationHref', () => {
  it('opens the conversations tab on the dialog', () => {
    expect(conversationHref('abc')).toBe('/admin/assistant?tab=conversations&conversation=abc');
  });
});

describe('unansweredQuestionTexts', () => {
  it("puts the person's words first and keeps the restatement second", () => {
    expect(unansweredQuestionTexts({ question: 'How do guests get access?', userQuestion: 'guest access how' })).toEqual({
      primary: 'guest access how',
      restated: 'How do guests get access?',
    });
  });

  it('falls back to the restatement when there is no user message, and drops a restatement that only differs in case or spacing', () => {
    expect(unansweredQuestionTexts({ question: 'Restated', userQuestion: null })).toEqual({ primary: 'Restated', restated: null });
    expect(unansweredQuestionTexts({ question: 'Restated', userQuestion: '   ' })).toEqual({ primary: 'Restated', restated: null });
    expect(unansweredQuestionTexts({ question: 'Where is the  trash?', userQuestion: 'where is the trash?' })).toEqual({ primary: 'where is the trash?', restated: null });
  });
});

describe('spaceOptionLabels', () => {
  it('uses the name, adds the slug only for duplicate names, and marks a deleted space', () => {
    const labels = spaceOptionLabels(
      [
        { slug: 'eng', name: 'Engineering' },
        { slug: 'hr-1', name: 'People' },
        { slug: 'hr-2', name: 'People' },
        { slug: 'old', name: null },
      ],
      'deleted',
    );
    expect(Object.fromEntries(labels)).toEqual({ eng: 'Engineering', 'hr-1': 'People (hr-1)', 'hr-2': 'People (hr-2)', old: 'old (deleted)' });
  });
});
