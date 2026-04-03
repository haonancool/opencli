import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../../registry.js';
import './topics.js';

describe('zsxq topics command', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('requires an explicit group_id when there is no active group context', async () => {
    const command = getRegistry().get('zsxq/topics');
    expect(command?.func).toBeTypeOf('function');

    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(null),
    } as any;

    await expect(command!.func!(mockPage, { limit: 20 })).rejects.toMatchObject({
      code: 'ARGUMENT',
      message: 'Cannot determine active group_id',
    });

    expect(mockPage.goto).toHaveBeenCalledWith('https://wx.zsxq.com');
    expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
  });

  it('surfaces inline comment previews in the default table columns', () => {
    const command = getRegistry().get('zsxq/topics');
    expect(command?.columns).toContain('comment_preview');
  });

  it('preserves raw talk and show_comments details from the topics API response', async () => {
    const command = getRegistry().get('zsxq/topics');
    expect(command?.func).toBeTypeOf('function');

    const payload = {
      succeeded: true,
      resp_data: {
        topics: [
          {
            topic_id: 123,
            type: 'talk',
            title: 'Short title',
            talk: {
              owner: { name: 'Bob' },
              text: 'Full talk body',
              images: [{ image_id: 1 }],
            },
            latest_likes: [
              {
                owner: { name: 'Liker' },
              },
            ],
            likes_detail: {
              emojis: [{ emoji_key: '[强]', likes_count: 2 }],
            },
            user_specific: {
              liked: false,
            },
            show_comments: [
              {
                comment_id: 9,
                owner: { name: 'Alice' },
                text: 'First comment',
              },
            ],
            comments_count: 1,
            likes_count: 2,
            create_time: '2026-04-01T18:16:31.470+0800',
          },
        ],
      },
    };

    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          url: 'https://api.zsxq.com/v2/groups/123/topics?scope=all&count=20',
          data: payload,
        }),
    } as any;

    const rows = await command!.func!(mockPage, { limit: 20, group_id: '123' });
    expect(rows).toEqual([
      expect.objectContaining({
        topic_id: 123,
        content: 'Full talk body',
        title: 'Short title',
        comment_preview: 'Alice: First comment',
        talk: payload.resp_data.topics[0].talk,
        show_comments: payload.resp_data.topics[0].show_comments,
      }),
    ]);
    expect(rows).toEqual([
      expect.not.objectContaining({
        latest_likes: expect.anything(),
      }),
    ]);
    expect(rows).toEqual([
      expect.not.objectContaining({
        likes_detail: expect.anything(),
      }),
    ]);
    expect(rows).toEqual([
      expect.not.objectContaining({
        user_specific: expect.anything(),
      }),
    ]);
  });
});
