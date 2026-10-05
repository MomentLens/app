import type { AlbumMediaItem, SubEvent } from '@momentlens/shared-types';

export interface AlbumHeaderItem {
  type: 'header';
  key: string;
  subEventId: string;
  subEvent: SubEvent;
  numeral: number;
  count: number;
  isLive: boolean;
}

export interface AlbumPhotoItem {
  type: 'media';
  key: string;
  media: AlbumMediaItem;
}

export type AlbumListItem = AlbumHeaderItem | AlbumPhotoItem;

export interface SubEventChipItem {
  id: string | null;
  name: string;
  isLive: boolean;
  order: number;
}
