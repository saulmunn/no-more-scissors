// Built-in example posts for calibration. `posts` are rated 0–100 by the user during onboarding
// (their answers become examples in their own scoring prompt); `check` is a held-out set the
// settings page can score with the model so the user can see how the scale behaves on new posts.
// Every post is invented; none quotes a real account. Keep ids stable: stored calibrations use them.
window.NMS_CALIBRATION = {
  posts: [
    { id: 'c1', text: 'Genuinely think the new congestion pricing is a bad policy and the data from London backs that up. Happy to be argued out of it.' },
    { id: 'c2', text: 'A kid died because the city ignored 40 complaints about that intersection. I am furious and you should be too.' },
    { id: 'c3', text: "I'm so fucking tired of my landlord 'fixing' the boiler by turning it off and on. Third winter of this." },
    { id: 'c4', text: 'lol the amount of people who confidently posted about this yesterday and are now quietly deleting… never change, twitter' },
    { id: 'c5', text: "This paper's methods section is a disaster and the reviewers should be embarrassed for waving it through." },
    { id: 'c6', text: "Journalists at this outlet aren't confused, they're lying, and they know their readers are too dumb to check." },
    { id: 'c7', text: "Every single one of these tech bros is a spineless parasite who'd sell his mother for a term sheet." },
    { id: 'c8', text: 'People who vote for that party are subhuman and honestly deserve whatever comes to them.' },
  ],
  check: [
    { id: 'k1', text: 'Reminder that the 9pm train is cancelled all week. Bus replacement from platform 4, allow an extra 25 minutes.' },
    { id: 'k2', text: "Strong disagree with the take that remote work killed mentorship. It killed *bad* mentorship. The good stuff moved to Slack and got better." },
    { id: 'k3', text: 'ah yes, another "I built a startup in a weekend" thread from someone whose weekend had a team of six and a seed round' },
    { id: 'k4', text: "The ref lost control of that match in the 60th minute and everyone in the stadium knew it. Absolute shambles." },
    { id: 'k5', text: "Anyone still defending this company at this point is either paid to or has stopped thinking. There's no third option." },
    { id: 'k6', text: 'Imagine being this dumb and still having a verified badge. Every one of your followers should be embarrassed.' },
    { id: 'k7', text: "Landlords are leeches. Not people, leeches. Stop pretending there's a nice one somewhere." },
    { id: 'k8', text: "I hope every single one of them gets what's coming to them, and I hope it hurts." },
  ],
};
