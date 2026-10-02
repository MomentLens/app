import { TabStack } from '@/components/ui/tab-stack';

// The Schedule tab's own Stack. Sub-event Detail and Delay open from the (app) Stack instead, so
// their sheets cover the whole Event shell on Android (D-125).
export default TabStack;
