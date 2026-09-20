/**
 * Custom hook for managing token creation form state
 */

import { useState } from "react";
import { toast } from "sonner";
import { TokenCategory, TokenFormData } from "@/types/token";

/** Mirrors the accepted types in frontend/api/upload.js. */
const TOKEN_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
/** Mirrors maxBytes in frontend/api/upload.js. */
const TOKEN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;


const initialFormData: TokenFormData = {
  name: "",
  ticker: "",
  description: "",
  category: "meme",
  image: null,
  imagePreview: "",
  website: "",
  twitter: "",
  telegram: "",
  discord: "",
  otherLink: "",
  showSocialLinks: false,
};

export const useTokenForm = () => {
  const [formData, setFormData] = useState<TokenFormData>(initialFormData);

  const setTokenName = (name: string) => {
    setFormData((prev) => ({ ...prev, name }));
  };

  const setTicker = (ticker: string) => {
    setFormData((prev) => ({ ...prev, ticker: ticker.toUpperCase() }));
  };

  const setDescription = (description: string) => {
    setFormData((prev) => ({ ...prev, description }));
  };

  const setCategory = (category: TokenCategory) => {
    setFormData((prev) => ({ ...prev, category }));
  };

  const setWebsite = (website: string) => {
    setFormData((prev) => ({ ...prev, website }));
  };

  const setTwitter = (twitter: string) => {
    setFormData((prev) => ({ ...prev, twitter }));
  };

  const setTelegram = (telegram: string) => {
    setFormData((prev) => ({ ...prev, telegram }));
  };

  const setDiscord = (discord: string) => {
    setFormData((prev) => ({ ...prev, discord }));
  };

  const setOtherLink = (otherLink: string) => {
    setFormData((prev) => ({ ...prev, otherLink }));
  };

  const setShowSocialLinks = (show: boolean) => {
    setFormData((prev) => ({ ...prev, showSocialLinks: show }));
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];

      // The accept attribute is a hint a file picker can ignore, and nothing
      // else checked this before the upload reached the server, so a creator
      // got a bare 400 with no idea which rule they broke. Animated GIFs are
      // the common case for going over the size cap.
      if (!TOKEN_IMAGE_TYPES.has(file.type)) {
        toast.error("Use a PNG, JPG, WEBP or GIF image.");
        e.target.value = "";
        return;
      }
      if (file.size > TOKEN_IMAGE_MAX_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        toast.error(`That image is ${mb} MB. The limit is 5 MB — try a shorter or smaller GIF.`);
        e.target.value = "";
        return;
      }

      setFormData((prev) => ({ ...prev, image: file }));
      
      const reader = new FileReader();
      reader.onloadend = () => {
        setFormData((prev) => ({ ...prev, imagePreview: reader.result as string }));
      };
      reader.readAsDataURL(file);
      toast.success("Image uploaded successfully!");
    }
  };

  const handleRemoveImage = () => {
    setFormData((prev) => ({ ...prev, image: null, imagePreview: "" }));
  };

  const handleReset = () => {
    setFormData(initialFormData);
    toast.success("Form reset!");
  };

  const clearSocialLinks = () => {
    setFormData((prev) => ({
      ...prev,
      showSocialLinks: false,
      website: "",
      twitter: "",
      telegram: "",
      discord: "",
      otherLink: "",
    }));
  };

  return {
    formData,
    setTokenName,
    setTicker,
    setDescription,
    setCategory,
    setWebsite,
    setTwitter,
    setTelegram,
    setDiscord,
    setOtherLink,
    setShowSocialLinks,
    handleImageChange,
    handleRemoveImage,
    handleReset,
    clearSocialLinks,
  };
};
