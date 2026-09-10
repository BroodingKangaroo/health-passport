import '@testing-library/jest-dom/vitest'

// jsdom does not implement Element.scrollIntoView, which the BloodTestDetails
// tab strip calls on activation/focus.
Element.prototype.scrollIntoView = () => {}
