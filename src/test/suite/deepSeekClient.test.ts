import * as assert from 'assert';
import { testingHooks, TranslationUnit } from '../../deepSeekClient';

suite('deepSeekClient', () => {
  teardown(() => {
    testingHooks.resetPostJsonImplementation();
  });

  test('recovers missing markdown translation segments', async () => {
    const units: TranslationUnit[] = [
      {
        id: 'S0',
        text: 'First paragraph.',
        restoreInline: (translated): string => translated,
      },
      {
        id: 'S1',
        text: 'Second paragraph.',
        restoreInline: (translated): string => translated,
      },
    ];
    let callCount = 0;

    testingHooks.setPostJsonImplementation(
      async <T>(
        _baseUrl: string,
        _path: string,
        _apiKey: string,
        body: unknown
      ): Promise<T> => {
        callCount += 1;
        const request = body as { messages: Array<{ content: string }> };
        const requestedUnits = JSON.parse(
          request.messages[1].content
        ) as Array<{ id: string }>;
        const content =
          callCount === 1
            ? JSON.stringify([{ id: 'S0', translation: '第一段。' }])
            : JSON.stringify(
                requestedUnits.map((unit) => ({
                  id: unit.id,
                  translation: unit.id === 'S1' ? '第二段。' : '补译。',
                }))
              );

        return ({
          choices: [
            {
              message: {
                content,
              },
            },
          ],
        } as unknown) as T;
      }
    );

    const translations = await testingHooks.translateMarkdownUnits(
      units,
      'key',
      'https://example.com',
      'model',
      'Translate.',
      6,
      undefined
    );

    assert.strictEqual(translations.get('S0'), '第一段。');
    assert.strictEqual(translations.get('S1'), '第二段。');
    assert.strictEqual(callCount, 2);
  });

  test('translates markdown batches with a maximum concurrency of 20', async () => {
    const units: TranslationUnit[] = Array.from(
      { length: 25 },
      (_item, index) => ({
        id: `S${index}`,
        text: `${index} `.repeat(2500),
        restoreInline: (translated): string => translated,
      })
    );
    let activeRequests = 0;
    let peakRequests = 0;

    testingHooks.setPostJsonImplementation(
      async <T>(
        _baseUrl: string,
        _path: string,
        _apiKey: string,
        body: unknown
      ): Promise<T> => {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests -= 1;

        const request = body as { messages: Array<{ content: string }> };
        const requestedUnits = JSON.parse(
          request.messages[1].content
        ) as Array<{ id: string }>;
        return ({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  requestedUnits.map((unit) => ({
                    id: unit.id,
                    translation: `translated ${unit.id}`,
                  }))
                ),
              },
            },
          ],
        } as unknown) as T;
      }
    );

    const translations = await testingHooks.translateMarkdownUnits(
      units,
      'key',
      'https://example.com',
      'model',
      'Translate.',
      20,
      undefined
    );

    assert.strictEqual(translations.size, 25);
    assert.strictEqual(peakRequests, 20);
  });
});
